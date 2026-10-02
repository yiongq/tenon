/**
 * The custom vendor routes (M6 §IPC): the instance section of the settings card lists, creates,
 * renames, deletes, fetches a model list for and probes instances through these, all through
 * `registerRoute` (AGENTS.md: no ad-hoc `ipcMain.handle`). A key travels renderer → main only, in
 * `customVendor.create`; no response has a field it could travel back in. A later key is saved by
 * `provider.configure` (provider-routes.ts), which aborts the instance's probe the way a delete here
 * does.
 *
 * The probe (§探测「何时、走哪条路」, §回环与私网):
 *
 *   - one per instance at a time, the second answers `busy`; a loopback or private instance answers
 *     `local-endpoint` and sends nothing (Q7);
 *   - the key and the row are read as one save left them (`readSettledInputs`). A read a save landed
 *     in, or a key bound to another host, is not sent: `probeModel` is handed the instance's
 *     definition with a `create()` that throws `ProviderConfigMissingError`, so the kernel itself
 *     records `failed` / `config` with no request — the way §存储 already has the view treat a refused
 *     address — and keeps §两步 T10's rule for the snapshot's `maxTokensField` in one place;
 *   - the result is stored in the profile's lock, only while the instance and the row are still
 *     there and no write changed the instance's settings or key since that read (M6 不变量 12);
 *   - aborted by the user (`customVendor.cancelProbe`), a key save or the app quitting, it answers
 *     `aborted`; by a delete, `not-found`; nothing is stored either way. Past the save's abort check
 *     the result is stored, and a cancel then answers `cancelled: false`.
 */
import {
  customVendorCancelProbe,
  customVendorCreate,
  customVendorDelete,
  customVendorFetchModels,
  customVendorList,
  customVendorProbe,
  customVendorUpdate,
  registerRoute,
} from '@tenon-app/contracts'
import type { IpcMainLike, RouteResponse } from '@tenon-app/contracts'
import { ProviderConfigMissingError, fetchRemoteModels, probeModel } from '@tenon-app/kernel'
import type {
  HostAdapter,
  ProbeSnapshot,
  ProviderDefinition,
  ProviderRegistry,
} from '@tenon-app/kernel'
import {
  providerSettingsGeneration,
  readConfig,
  withConfigLock,
  writeConfigHeld,
} from '../host/profile.js'
import { declaredBaseURL, devEnv, readSettledInputs, unboundSecrets } from '../provider.js'
import type { EnvLike, SettledInputs } from '../provider.js'
import { requestMaxTokens } from '../run-assembly.js'
import { vendorPresets } from './presets.js'
import { instanceDefinition, instanceReach, instanceRefusal, instanceRow } from './registry.js'
import { createCustomVendor, deleteCustomVendorHeld, updateCustomVendor } from './store.js'

/** Why a running probe was stopped: the user, a key save, a delete (§何时、走哪条路). */
export type ProbeStop = 'cancel' | 'key' | 'delete'

/** The probes running now, one per instance at most. */
export interface ProbeRuns {
  /**
   * Aborts the instance's running probe, which then stores nothing; false when none is running, or
   * when the one running is already storing its result (`commit`) — every cancel answers as what was
   * stored. A delete outranks an earlier reason: the probe answers `not-found`.
   */
  abort(id: string, why: ProbeStop): boolean
  /** Begins a probe of the instance, or null while one is running (`busy`). */
  begin(id: string, exit: AbortSignal | undefined): ProbeRun | null
  /**
   * Past its last abort check, in the profile's lock: its result is stored whatever comes next. It
   * stays registered, so the instance still answers `busy` until the write is done.
   */
  commit(run: ProbeRun): void
  /** The probe is over: the instance may be probed again. */
  end(run: ProbeRun): void
}

export interface ProbeRun {
  readonly id: string
  /** Aborted by `abort` or by the app quitting. */
  readonly signal: AbortSignal
  /** Why `abort` stopped it; null while it was not, or when the app's quit did. */
  readonly why: ProbeStop | null
}

interface Running extends ProbeRun {
  readonly controller: AbortController
  why: ProbeStop | null
  committed: boolean
}

export function createProbeRuns(): ProbeRuns {
  const runs = new Map<string, Running>()
  return {
    abort(id, why) {
      const running = runs.get(id)
      if (running === undefined || running.committed) return false
      if (running.why === null || why === 'delete') running.why = why
      running.controller.abort(why)
      return true
    },
    begin(id, exit) {
      if (runs.has(id)) return null
      const controller = new AbortController()
      const signal =
        exit === undefined ? controller.signal : AbortSignal.any([controller.signal, exit])
      const running: Running = { id, controller, signal, why: null, committed: false }
      runs.set(id, running)
      return running
    },
    commit(run) {
      const running = runs.get(run.id)
      if (running === run) running.committed = true
    },
    end(run) {
      if (runs.get(run.id) === run) runs.delete(run.id)
    },
  }
}

export interface CustomVendorRoutesDeps {
  readonly ipcMain: IpcMainLike
  readonly host: HostAdapter
  /** The registry view (§注册表视图): builtins, then the instances as the last write left them. */
  readonly providers: ProviderRegistry
  /** Shared with `provider.configure`, whose key save aborts a running probe. */
  readonly probes: ProbeRuns
  /** A lowercase canonical UUID: a new instance's id (T1) and a probe's runId. */
  readonly uuid: () => string
  /** Aborted when the app quits (shutdown step 3): a probe and a model list stop on it. */
  readonly signal?: AbortSignal
  /** `app.isPackaged`: only a development build reads `TENON_MAX_TOKENS` (as a send does). */
  readonly isPackaged?: boolean
  readonly env?: EnvLike
  readonly log?: (line: string) => void
}

type ListAnswer = RouteResponse<typeof customVendorList>
type ProbeAnswer = RouteResponse<typeof customVendorProbe>
type ModelsAnswer = RouteResponse<typeof customVendorFetchModels>

export function registerCustomVendorRoutes(deps: CustomVendorRoutesDeps): void {
  const { ipcMain, host, providers, probes } = deps
  const log = deps.log ?? ((line: string): void => console.warn(line))
  const env = (): EnvLike => devEnv({ isPackaged: deps.isPackaged === true, env: deps.env })
  const store = { host, log, uuid: deps.uuid }

  registerRoute(ipcMain, customVendorList, async () => {
    const config = await readConfig(host.fs, host.identity, log)
    // §存储: an entry whose address fails §地址校验 is listed, with the code the card marks it by.
    const instances: ListAnswer['instances'] = []
    for (const entry of config.customVendors) {
      const refusal = instanceRefusal(entry)
      instances.push(refusal === null ? entry : { ...entry, refused: refusal })
    }
    return { presets: vendorPresets(), instances }
  })

  registerRoute(ipcMain, customVendorCreate, (request) => createCustomVendor(store, request))

  registerRoute(ipcMain, customVendorUpdate, (request) => updateCustomVendor(store, request))

  registerRoute(ipcMain, customVendorDelete, ({ id }) =>
    // §写入规则「删除」: the running probe first, in the same lock, so it cannot store a result after
    // the entry is gone; then the key and the entry.
    withConfigLock(host.identity, () => {
      probes.abort(id, 'delete')
      return deleteCustomVendorHeld(store, id)
    }),
  )

  registerRoute(ipcMain, customVendorCancelProbe, ({ id }) => ({
    cancelled: probes.abort(id, 'cancel'),
  }))

  registerRoute(ipcMain, customVendorFetchModels, async ({ id }): Promise<ModelsAnswer> => {
    // T7: only now, because the user pressed 「获取模型列表」.
    const definition = providers.get(id)
    if (definition === null) return { ok: false, code: 'not-found' }
    const vars = env()
    const read = await readSettledInputs({ host, definition, env: vars, log })
    const entry = read.config.customVendors.find((candidate) => candidate.id === id)
    if (entry === undefined) return { ok: false, code: 'not-found' }
    // §存储: a refused address sends nothing; §列表与上限: nor does a key 02's binding would refuse.
    if (instanceRefusal(entry) !== null || !sendable(definition, read, vars)) {
      return { ok: false, code: 'config' }
    }
    // The quit aborts it (§列表与上限); the route then fails as the window closes, with no answer
    // in the union to give.
    const listed = await fetchRemoteModels({
      vendor: {
        id,
        wire: entry.wire,
        baseURL: entry.baseURL,
        keyRequired: instanceReach(entry) === 'public',
      },
      secrets: read.inputs.secrets,
      network: host.network,
      clock: { setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms) },
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
    // A code only: never the status, never a body (§列表与上限).
    if (!listed.ok) return { ok: false, code: listed.code }
    // An id and the two limits it found, each only when it found one: what the schema carries.
    return { ok: true, models: [...listed.models] }
  })

  registerRoute(ipcMain, customVendorProbe, async ({ id, modelId }): Promise<ProbeAnswer> => {
    const definition = providers.get(id)
    if (definition === null) return refused('not-found')
    if (!definition.builtinModels.some((model) => model.id === modelId)) {
      return refused('unknown-model')
    }
    // Q7: no probe button, and no request, for this machine or a private network.
    if (instanceReach({ baseURL: declaredBaseURL(definition) ?? '' }) !== 'public') {
      return refused('local-endpoint')
    }
    // Taken before anything is awaited, so a second press cannot slip in between.
    const run = probes.begin(id, deps.signal)
    if (run === null) return refused('busy')
    try {
      return await probe(definition, modelId, run)
    } catch (error) {
      if (run.signal.aborted) return stopped(run)
      throw error
    } finally {
      probes.end(run)
    }
  })

  async function probe(
    definition: ProviderDefinition,
    modelId: string,
    run: ProbeRun,
  ): Promise<ProbeAnswer> {
    const id = definition.id
    const vars = env()
    // The key, the address and the row as one save left them (§何时、走哪条路).
    const read = await readSettledInputs({ host, definition, env: vars, log })
    const entry = read.config.customVendors.find((candidate) => candidate.id === id)
    const row = entry?.models.find((candidate) => candidate.id === modelId)
    if (entry === undefined) return run.signal.aborted ? stopped(run) : refused('not-found')
    if (row === undefined) return run.signal.aborted ? stopped(run) : refused('unknown-model')
    const instance = instanceDefinition(entry)
    const snapshot = await probeModel({
      // §结果与原因码 `config`「发出之前」: a read a save landed in, or a key bound elsewhere.
      definition: sendable(definition, read, vars) ? instance : unsendable(instance),
      row: instanceRow(row),
      network: host.network,
      clock: {
        now: () => host.clock.now(),
        setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
      },
      config: read.inputs.config,
      secrets: read.inputs.secrets,
      maxTokens: requestMaxTokens(vars, row),
      policy: host.policy.current(),
      tenantId: host.identity.tenantId,
      ids: { uuid: deps.uuid },
      signal: run.signal,
    })
    return save(id, modelId, snapshot, read, run)
  }

  /** §何时、走哪条路「保存」: in the profile's lock, or not at all. */
  function save(
    id: string,
    modelId: string,
    snapshot: ProbeSnapshot,
    read: SettledInputs,
    run: ProbeRun,
  ): Promise<ProbeAnswer> {
    return withConfigLock(host.identity, async () => {
      const config = await readConfig(host.fs, host.identity, log)
      // First, and after the read, so a cancel or the quit that came while the file was read counts.
      if (run.signal.aborted) return stopped(run)
      // §何时、走哪条路「取消」: from here the answer is `done`, so a cancel answers `cancelled: false`.
      probes.commit(run)
      const index = config.customVendors.findIndex((candidate) => candidate.id === id)
      const entry = config.customVendors[index]
      const rowIndex = entry?.models.findIndex((candidate) => candidate.id === modelId) ?? -1
      const row = entry?.models[rowIndex]
      // A save of the key — done or failed — a rename, a row change or a delete since the read.
      const current = providerSettingsGeneration(host.identity, id) === read.settingsGeneration
      if (entry === undefined || row === undefined || !current) {
        return { status: 'done', snapshot, saved: false }
      }
      await writeConfigHeld(host.fs, host.identity, {
        customVendors: config.customVendors.with(index, {
          ...entry,
          models: entry.models.with(rowIndex, { ...row, probe: snapshot }),
        }),
      })
      return { status: 'done', snapshot, saved: true }
    })
  }
}

/** 02's read-settle and key-binding checks before anything is sent (provider.ts:184-247). */
function sendable(definition: ProviderDefinition, read: SettledInputs, vars: EnvLike): boolean {
  if (!read.settled) return false
  const settings = read.config.providerConfig[definition.id]
  return unboundSecrets(definition, settings, vars, read.inputs).length === 0
}

/** The instance's definition with no client to build: the probe records `config`, sending nothing. */
function unsendable(definition: ProviderDefinition): ProviderDefinition {
  return {
    ...definition,
    create() {
      throw new ProviderConfigMissingError(
        definition.id,
        'a key read while no save changed it, bound to the host it sends to',
      )
    },
  }
}

function refused(
  code: Extract<ProbeAnswer, { status: 'refused' }>['code'],
): Extract<ProbeAnswer, { status: 'refused' }> {
  return { status: 'refused', code }
}

/** A probe stopped before it stored anything: a delete's is `not-found`, the rest `aborted`. */
function stopped(run: ProbeRun): ProbeAnswer {
  return refused(run.why === 'delete' ? 'not-found' : 'aborted')
}
