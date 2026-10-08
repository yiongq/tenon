export type McpLoginResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code:
        | 'metadata-unreachable'
        | 'pkce-unsupported'
        | 'issuer-mismatch'
        | 'iss-mismatch'
        | 'needs-client'
        | 'issuer-changed'
        | 'denied'
        | 'timeout'
        | 'port-in-use'
        | 'unsafe-url'
        | 'cancelled'
        | 'keychain'
        | 'network'
    }
export interface McpLoginUi {
  listen(port: number | 0): Promise<{
    readonly port: number
    waitForCallback(state: string, timeoutMs: number): Promise<URLSearchParams>
    close(): Promise<void>
  }>
  openUrl(url: URL): Promise<void>
}

import {
  auth,
  discoverOAuthServerInfo,
  IssuerMismatchError,
  UnauthorizedError,
  AuthorizationServerMismatchError,
  OAuthError,
  OAuthErrorCode,
} from '@modelcontextprotocol/client'
import type {
  AuthProvider,
  OAuthClientProvider,
  OAuthClientInformationContext,
  OAuthDiscoveryState,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { FetchLike, HostIdentity, HostSecrets } from '../host/adapter.js'
import { keyFor } from '../host/key.js'
import { sha256Hex } from '../tape/hash.js'
import { McpUnauthorizedError, isMcpAuthError } from './connection.js'
import type { McpOAuthRuntime } from './pool.js'
import { McpKeychainError } from './token-store.js'
import type { McpTokenStore, McpTokenTransaction } from './token-store.js'

export interface McpOAuthProvider extends OAuthClientProvider {
  readonly authProvider: AuthProvider
  login(ui: McpLoginUi): Promise<McpLoginResult>
  cancelLogin(): boolean
}
type LoginCode = Extract<McpLoginResult, { ok: false }>['code']
interface LoginState {
  readonly ui: McpLoginUi
  readonly abort: AbortController
  readonly state: string
  readonly redirect: string
  discovery: OAuthDiscoveryState | undefined
  readonly route: 'own' | 'cimd' | 'dcr'
  verifier: string | null
}
export function createMcpOAuthProvider(q: {
  readonly serverId: string
  readonly ids: { uuid(): string }
  readonly serverUrl: string
  readonly fetch: FetchLike
  readonly runtime: () => McpOAuthRuntime
  readonly identity: HostIdentity
  readonly secrets: HostSecrets
  readonly store: McpTokenStore
  /** Current issuer after a successful configuration write. */
  readonly currentIssuerHash: () => string | null
  readonly onUnauthorized: () => void
  readonly addSecret: (value: string) => void
  readonly requiredScope?: () => string | undefined
  readonly isActive?: () => boolean
  readonly onDiscovery?: (issuer: string) => void
}): McpOAuthProvider {
  const active = () => q.isActive?.() ?? true
  const memory = new Map<string, Promise<StoredOAuthTokens | undefined>>()
  let loginState: LoginState | null = null
  let loginAbort: AbortController | null = null
  let lastRedirect: string | null = null
  let lastDiscovery: OAuthDiscoveryState | undefined
  let lastSavedHash: string | null = q.runtime().issuers.at(-1) ?? null
  let refresh: Promise<void> | null = null
  let listener: Awaited<ReturnType<McpLoginUi['listen']>> | null = null
  const hashOf = (ctx?: OAuthClientInformationContext) =>
    ctx?.issuer === undefined
      ? (q.currentIssuerHash() ?? lastSavedHash)
      : sha256Hex(ctx.issuer).slice(0, 16)
  async function tokens(ctx?: OAuthClientInformationContext, tx: McpTokenTransaction = q.store) {
    if (!active()) return undefined
    const hash = hashOf(ctx)
    if (hash === null) return undefined
    if (!memory.has(hash))
      memory.set(
        hash,
        tx
          .tokens(hash)
          .then((value) => {
            if (value) {
              q.addSecret(value.access_token)
              if (value.refresh_token) q.addSecret(value.refresh_token)
            }
            return value
          })
          .catch((error) => {
            memory.delete(hash)
            throw error
          }),
      )
    return memory.get(hash)!
  }
  async function client(ctx?: OAuthClientInformationContext, tx: McpTokenTransaction = q.store) {
    if (!active()) throw new UnauthorizedError()
    const own = q.runtime().ownClient
    if (own) {
      const issuer = own.issuer ?? (loginState ? ctx?.issuer : undefined)
      if (issuer === undefined) throw new LoginError('needs-client')
      if (ctx?.issuer !== undefined && issuer !== ctx.issuer) throw new LoginError('issuer-changed')
      const secret = own.hasSecret
        ? await q.secrets.get(keyFor(q.identity, 'mcp', q.serverId, 'oauth', 'own', 'secret'))
        : null
      if (own.hasSecret && secret === null) throw new McpKeychainError()
      if (secret !== null) q.addSecret(secret)
      return {
        client_id: own.clientId,
        issuer,
        ...(secret === null ? {} : { client_secret: secret }),
      }
    }
    const hash = hashOf(ctx)
    if (hash === null) return undefined
    const stored = await tx.client(hash)
    if (stored?.client_secret) q.addSecret(stored.client_secret)
    if (loginState?.route === 'cimd' && stored?.client_id !== q.runtime().clientMetadataUrl)
      return undefined
    if (loginState?.route === 'dcr' && stored?.client_id === q.runtime().clientMetadataUrl)
      return undefined
    return stored
  }
  async function saveTokens(
    value: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
    tx: McpTokenTransaction = q.store,
  ) {
    if (!active()) throw new McpKeychainError()
    loginState?.abort.signal.throwIfAborted()
    const hash = hashOf(ctx)
    if (hash === null || ctx?.issuer === undefined) throw new McpKeychainError()
    await tx.saveTokens({ hash, url: ctx.issuer }, value)
    lastSavedHash = hash
    memory.set(hash, Promise.resolve(value))
    q.addSecret(value.access_token)
    if (value.refresh_token) q.addSecret(value.refresh_token)
  }
  async function invalidate(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
    tx: McpTokenTransaction = q.store,
  ) {
    const hash = hashOf()
    if ((scope === 'all' || scope === 'tokens') && hash !== null) {
      await tx.deleteTokens(hash)
      memory.delete(hash)
    }
    if (
      (scope === 'all' || scope === 'client') &&
      hash !== null &&
      q.runtime().ownClient === null
    ) {
      const stored = await tx.client(hash)
      if (stored?.client_id !== q.runtime().clientMetadataUrl) await tx.deleteClient(hash)
    }
    if ((scope === 'all' || scope === 'verifier') && loginState && tx === q.store)
      loginState.verifier = null
    if ((scope === 'all' || scope === 'discovery') && loginState && tx === q.store)
      loginState.discovery = undefined
  }
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return (
        loginState?.redirect ??
        lastRedirect ??
        `http://127.0.0.1:${q.runtime().ownClient?.redirectPort ?? q.runtime().dcrRedirectPort}/callback`
      )
    },
    get clientMetadata() {
      return {
        client_name: 'Tenon',
        application_type: 'native',
        token_endpoint_auth_method: q.runtime().ownClient?.hasSecret
          ? 'client_secret_post'
          : 'none',
        redirect_uris: [String(provider.redirectUrl)],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }
    },
    state: () => {
      if (!loginState) throw new UnauthorizedError()
      return loginState.state
    },
    clientInformation: client,
    saveClientInformation: async (value, ctx) => {
      if (!active()) throw new McpKeychainError()
      loginState?.abort.signal.throwIfAborted()
      const hash = hashOf(ctx)
      if (hash === null || ctx?.issuer === undefined) throw new McpKeychainError()
      if (value.client_secret) q.addSecret(value.client_secret)
      if (q.runtime().ownClient === null) await q.store.saveClient({ hash, url: ctx.issuer }, value)
    },
    tokens,
    saveTokens,
    async redirectToAuthorization(url) {
      if (!loginState) {
        q.onUnauthorized()
        throw new UnauthorizedError()
      }
      await loginState.ui.openUrl(url)
    },
    saveCodeVerifier: (value) => {
      if (!loginState) throw new UnauthorizedError()
      loginState.verifier = value
    },
    codeVerifier: () => {
      if (!loginState?.verifier) throw new UnauthorizedError()
      return loginState.verifier
    },
    saveDiscoveryState: (value) => {
      if (loginState) {
        loginState.discovery = value
        lastDiscovery = value
      }
      if (active() && value.authorizationServerMetadata?.issuer)
        q.onDiscovery?.(value.authorizationServerMetadata.issuer)
    },
    discoveryState: () => loginState?.discovery,
    invalidateCredentials: invalidate,
  }
  const authProvider: AuthProvider = {
    token: async () => (await tokens())?.access_token,
    async onUnauthorized() {
      if (refresh) return refresh
      refresh = q.store
        .withLock(async (tx) => {
          const current = await tokens(undefined, tx)
          if (!current?.refresh_token || !(await client(undefined, tx)))
            throw new UnauthorizedError()
          let temporaryVerifier = ''
          const discovered =
            lastDiscovery ?? (await discoverOAuthServerInfo(q.serverUrl, { fetchFn: q.fetch }))
          let temporaryDiscovery: OAuthDiscoveryState | undefined = discovered
          // Deliberately omits saveClientInformation and clientMetadataUrl: invalid_client must not register.
          let transientFailure: unknown
          const refreshFetch: FetchLike = async (input, init) => {
            try {
              const response = await q.fetch(input, init)
              if (
                response.status >= 500 &&
                !new Request(input, init).url.includes('.well-known/oauth-protected-resource')
              )
                transientFailure = new OAuthError(
                  OAuthErrorCode.ServerError,
                  `OAuth server returned HTTP ${response.status}`,
                )
              return response
            } catch (error) {
              transientFailure = error
              throw error
            }
          }
          const noninteractive: OAuthClientProvider = {
            get redirectUrl() {
              return provider.redirectUrl
            },
            get clientMetadata() {
              return provider.clientMetadata
            },
            clientInformation: (ctx) => client(ctx, tx),
            tokens: (ctx) => tokens(ctx, tx),
            saveTokens: (value, ctx) => saveTokens(value, ctx, tx),
            invalidateCredentials: async (scope) => {
              await invalidate(scope, tx)
              if (scope === 'all' || scope === 'verifier') temporaryVerifier = ''
              if (scope === 'all' || scope === 'discovery') temporaryDiscovery = undefined
            },
            redirectToAuthorization: () => {
              if (transientFailure) throw transientFailure
              q.onUnauthorized()
              throw new UnauthorizedError()
            },
            saveCodeVerifier: (value) => {
              temporaryVerifier = value
            },
            codeVerifier: () => temporaryVerifier,
            saveDiscoveryState: (value) => {
              temporaryDiscovery = value
              if (active() && value.authorizationServerMetadata?.issuer)
                q.onDiscovery?.(value.authorizationServerMetadata.issuer)
            },
            discoveryState: () => temporaryDiscovery,
          }
          resourcePolicy(noninteractive, discovered)
          try {
            const result = await auth(noninteractive, {
              serverUrl: q.serverUrl,
              fetchFn: refreshFetch,
            })
            if (result !== 'AUTHORIZED') throw transientFailure ?? new UnauthorizedError()
          } catch (error) {
            throw transientFailure ?? error
          }
        })
        .catch((error) => {
          const registrationUnavailable =
            error instanceof Error &&
            error.message === 'OAuth client information must be saveable for dynamic registration'
          const authError =
            error instanceof OAuthError
              ? ['invalid_grant', 'invalid_client'].includes(error.code)
              : isMcpAuthError(error)
          if (
            !authError &&
            !registrationUnavailable &&
            !(error instanceof AuthorizationServerMismatchError) &&
            !(error instanceof LoginError)
          )
            throw error
          q.onUnauthorized()
          throw new McpUnauthorizedError()
        })
        .finally(() => {
          refresh = null
        })
      return refresh
    },
  }
  async function performLogin(ui: McpLoginUi, abort: AbortController): Promise<McpLoginResult> {
    const loginFetch: FetchLike = (input, init) => {
      const request = new Request(input, init)
      return q.fetch(
        new Request(request, { signal: AbortSignal.any([request.signal, abort.signal]) }),
      )
    }
    const scope = q.requiredScope?.()
    let info: OAuthDiscoveryState
    try {
      info = await discoverOAuthServerInfo(q.serverUrl, { fetchFn: loginFetch })
    } catch (e) {
      return {
        ok: false,
        code: abort.signal.aborted
          ? 'cancelled'
          : e instanceof IssuerMismatchError
            ? 'issuer-mismatch'
            : 'metadata-unreachable',
      }
    }
    resourcePolicy(provider, info)
    const metadata = info.authorizationServerMetadata
    if (!metadata) return { ok: false, code: 'metadata-unreachable' }
    if (!metadata.code_challenge_methods_supported?.includes('S256'))
      return { ok: false, code: 'pkce-unsupported' }
    const runtime = q.runtime()
    const route = runtime.ownClient
      ? 'own'
      : runtime.clientMetadataUrl &&
          metadata.client_id_metadata_document_supported === true &&
          metadata.token_endpoint_auth_methods_supported?.includes('none')
        ? 'cimd'
        : metadata.registration_endpoint
          ? 'dcr'
          : null
    if (!route) return { ok: false, code: 'needs-client' }
    if (
      runtime.ownClient?.issuer !== null &&
      runtime.ownClient?.issuer !== undefined &&
      runtime.ownClient.issuer !== metadata.issuer
    )
      return { ok: false, code: 'issuer-changed' }
    try {
      listener = await ui.listen(
        route === 'own'
          ? runtime.ownClient!.redirectPort
          : route === 'cimd'
            ? 0
            : runtime.dcrRedirectPort,
      )
      // UUIDs come from the injected source. Discard fixed version/variant octets;
      // three UUIDs provide 42 random octets, of which the state uses exactly 32.
      abort.signal.throwIfAborted()
      const bytes = Array.from({ length: 3 }, () => q.ids.uuid())
        .flatMap((uuid) => {
          const hex = uuid.replaceAll('-', '')
          return Array.from({ length: 16 }, (_, i) => i)
            .filter((i) => i !== 6 && i !== 8)
            .map((i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))
        })
        .slice(0, 32)
      const state = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
      loginState = {
        ui,
        abort,
        state,
        redirect: `http://127.0.0.1:${listener.port}/callback`,
        discovery: info,
        route,
        verifier: null,
      }
      lastRedirect = loginState.redirect
      if (route === 'cimd') provider.clientMetadataUrl = runtime.clientMetadataUrl!
      else delete provider.clientMetadataUrl

      await auth(provider, {
        serverUrl: q.serverUrl,
        fetchFn: loginFetch,
        forceReauthorization: true,
        ...(scope === undefined ? {} : { scope }),
      })
      const callback = await listener.waitForCallback(state, 120_000)
      abort.signal.throwIfAborted()
      const iss = callback.get('iss') ?? undefined
      if (callback.has('error')) {
        if (
          iss !== undefined
            ? iss !== metadata.issuer
            : metadata.authorization_response_iss_parameter_supported === true
        )
          throw new LoginError('iss-mismatch')
        throw new LoginError(callback.get('error') === 'access_denied' ? 'denied' : 'network')
      }
      const code = callback.get('code')
      if (!code) throw new LoginError('network')
      await auth(provider, {
        serverUrl: q.serverUrl,
        authorizationCode: code,
        ...(scope === undefined ? {} : { scope }),
        ...(iss === undefined ? {} : { iss }),
        fetchFn: loginFetch,
      })
      lastDiscovery = loginState.discovery
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        code:
          e instanceof LoginError
            ? e.code
            : e instanceof IssuerMismatchError
              ? e.kind === 'metadata'
                ? 'issuer-mismatch'
                : 'iss-mismatch'
              : e instanceof McpKeychainError
                ? 'keychain'
                : loginState?.abort.signal.aborted
                  ? 'cancelled'
                  : loginCode(e),
      }
    } finally {
      await listener?.close().catch(() => {})
      listener = null
      loginState = null
      delete provider.clientMetadataUrl
    }
  }
  return Object.assign(provider, {
    authProvider,
    cancelLogin() {
      if (!loginAbort) return false
      loginAbort.abort(new LoginError('cancelled'))
      void listener?.close()
      return true
    },
    async login(ui: McpLoginUi): Promise<McpLoginResult> {
      if (loginAbort !== null || !active()) return { ok: false, code: 'cancelled' }
      loginAbort = new AbortController()
      try {
        return await performLogin(ui, loginAbort)
      } finally {
        loginAbort = null
      }
    },
  })
}
class LoginError extends Error {
  readonly code: LoginCode
  constructor(code: LoginCode) {
    super(code)
    this.code = code
  }
}
function loginCode(error: unknown): LoginCode {
  if (
    error instanceof Error &&
    error.message.startsWith('Protected resource ') &&
    error.message.includes('does not match expected')
  )
    return 'metadata-unreachable'
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['port-in-use', 'unsafe-url', 'timeout', 'cancelled'].includes(String(error.code))
  )
    return error.code as LoginCode
  return 'network'
}

function resourcePolicy(target: OAuthClientProvider, discovery: OAuthDiscoveryState) {
  if (discovery.resourceMetadata) delete target.validateResourceURL
  else
    target.validateResourceURL = async (serverUrl) => {
      const url = new URL(serverUrl)
      url.hash = ''
      return url
    }
}
