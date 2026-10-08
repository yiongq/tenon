import type { StoredOAuthTokens, StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import type { HostIdentity, HostSecrets } from '../host/adapter.js'
import { keyFor } from '../host/key.js'

export class McpKeychainError extends Error {
  constructor() {
    super('keychain')
    this.name = 'McpKeychainError'
  }
}
export interface McpTokenTransaction {
  tokens(issuerHash: string): Promise<StoredOAuthTokens | undefined>
  saveTokens(issuerHash: string, tokens: StoredOAuthTokens): Promise<void>
  deleteTokens(issuerHash: string): Promise<void>
  client(issuerHash: string): Promise<StoredOAuthClientInformation | undefined>
  saveClient(issuerHash: string, client: StoredOAuthClientInformation): Promise<void>
  deleteClient(issuerHash: string): Promise<void>
}
export interface McpTokenStore extends McpTokenTransaction {
  withLock<T>(work: (transaction: McpTokenTransaction) => Promise<T>): Promise<T>
}
interface Group {
  readonly slot: 'a' | 'b'
  readonly generation: bigint
  readonly tokens: StoredOAuthTokens
}
export function createMcpTokenStore(q: {
  readonly secrets: HostSecrets
  readonly identity: HostIdentity
  readonly serverId: string
  readonly ids: { uuid(): string }
  readonly onIssuer: (issuerHash: string) => Promise<void>
  readonly deleting: () => boolean
  readonly log: (line: string) => void
}): McpTokenStore {
  let queue = Promise.resolve()
  const account = (hash: string, ...parts: string[]) =>
    keyFor(q.identity, 'mcp', q.serverId, 'oauth', hash, ...parts)
  const keys = (hash: string, slot: 'a' | 'b') =>
    Array.from({ length: 4 }, (_, i) => account(hash, 'tokens', slot, String(i)))
  async function groups(hash: string): Promise<Group[]> {
    const found = await Promise.all(
      (['a', 'b'] as const).map(async (slot) => {
        const shards = await Promise.all(keys(hash, slot).map((key) => q.secrets.get(key)))
        const parts = shards.map((shard) => shard?.split('.') ?? [])
        const first = parts[0]!
        const generation = first[0]?.match(/^(\d+)-[^.]+$/)?.[1]
        const n = Number(first[1])
        if (generation === undefined || !Number.isInteger(n) || n < 1 || n > 4 || first[2] !== '0')
          return null
        if (
          parts
            .slice(0, n)
            .some(
              (part, i) =>
                part.length !== 4 ||
                part[0] !== first[0] ||
                part[1] !== first[1] ||
                part[2] !== String(i) ||
                !/^[\w-]*$/.test(part[3] ?? ''),
            )
        )
          return null
        try {
          const encoded = parts
            .slice(0, n)
            .map((part) => part[3])
            .join('')
          const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
          const json = new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(binary, (char) => char.charCodeAt(0)),
          )
          const tokens = JSON.parse(json) as StoredOAuthTokens
          if (typeof tokens.access_token !== 'string' || typeof tokens.token_type !== 'string')
            return null
          return { slot, generation: BigInt(generation), tokens }
        } catch {
          return null
        }
      }),
    )
    return found
      .filter((group): group is Group => group !== null)
      .toSorted((a, b) =>
        a.generation === b.generation ? 0 : a.generation > b.generation ? -1 : 1,
      )
  }
  async function writable(hash: string) {
    if (q.deleting()) throw new McpKeychainError()
    await q.onIssuer(hash)
    if (q.deleting()) throw new McpKeychainError()
  }
  const rawTransaction: McpTokenTransaction = {
    async tokens(hash) {
      return (await groups(hash))[0]?.tokens
    },
    async saveTokens(hash, tokens) {
      const binary = Array.from(new TextEncoder().encode(JSON.stringify(tokens)), (byte) =>
        String.fromCharCode(byte),
      ).join('')
      const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
      const n = Math.ceil(encoded.length / 2300)
      if (n < 1 || n > 4) throw new McpKeychainError()
      const current = (await groups(hash))[0]
      const slot = current?.slot === 'a' ? 'b' : 'a'
      const generation = `${(current?.generation ?? 0n) + 1n}-${q.ids.uuid()}`
      await writable(hash)
      // Write fragments sequentially; a failed write leaves only an ignored partial new group.
      for (let i = 0; i < n; i++) {
        if (q.deleting()) throw new McpKeychainError()
        // oxlint-disable-next-line no-await-in-loop
        await q.secrets.set(
          account(hash, 'tokens', slot, String(i)),
          `${generation}.${n}.${i}.${encoded.slice(i * 2300, (i + 1) * 2300)}`,
        )
      }
      if (current)
        await Promise.all(
          keys(hash, current.slot).map((key) =>
            q.secrets.delete(key).catch(() => q.log('MCP old token fragment could not be deleted')),
          ),
        )
    },
    async deleteTokens(hash) {
      await Promise.all(
        [...keys(hash, 'a'), ...keys(hash, 'b')].map((key) => q.secrets.delete(key)),
      )
    },
    async client(hash) {
      const raw = await q.secrets.get(account(hash, 'client'))
      if (raw === null) return undefined
      try {
        const client = JSON.parse(raw) as StoredOAuthClientInformation
        return typeof client.client_id === 'string' ? client : undefined
      } catch {
        return undefined
      }
    },
    async saveClient(hash, client) {
      const allowed = new Set([
        'client_id',
        'client_secret',
        'client_id_issued_at',
        'client_secret_expires_at',
        'issuer',
      ])
      const stored = Object.fromEntries(
        Object.entries(client).filter(([name]) => allowed.has(name)),
      )
      await writable(hash)
      await q.secrets.set(account(hash, 'client'), JSON.stringify(stored))
    },
    async deleteClient(hash) {
      await q.secrets.delete(account(hash, 'client'))
    },
  }
  const keychain = async <T>(work: Promise<T>): Promise<T> =>
    work.catch(() => {
      throw new McpKeychainError()
    })
  const transaction: McpTokenTransaction = {
    tokens: (hash) => keychain(rawTransaction.tokens(hash)),
    saveTokens: (hash, tokens) => keychain(rawTransaction.saveTokens(hash, tokens)),
    deleteTokens: (hash) => keychain(rawTransaction.deleteTokens(hash)),
    client: (hash) => keychain(rawTransaction.client(hash)),
    saveClient: (hash, client) => keychain(rawTransaction.saveClient(hash, client)),
    deleteClient: (hash) => keychain(rawTransaction.deleteClient(hash)),
  }
  function withLock<T>(work: (tx: McpTokenTransaction) => Promise<T>): Promise<T> {
    const before = queue
    let release!: () => void
    queue = new Promise((resolve) => {
      release = resolve
    })
    return before.then(() => work(transaction)).finally(release)
  }
  return {
    withLock,
    tokens: (hash) => withLock((tx) => tx.tokens(hash)),
    saveTokens: (hash, tokens) => withLock((tx) => tx.saveTokens(hash, tokens)),
    deleteTokens: (hash) => withLock((tx) => tx.deleteTokens(hash)),
    client: (hash) => withLock((tx) => tx.client(hash)),
    saveClient: (hash, client) => withLock((tx) => tx.saveClient(hash, client)),
    deleteClient: (hash) => withLock((tx) => tx.deleteClient(hash)),
  }
}
