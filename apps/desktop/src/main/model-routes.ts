import { registerRoute, sessionModelChoice, sessionSelectModel } from '@tenon-app/contracts'
import type { IpcMainLike, ProviderWriteResult } from '@tenon-app/contracts'
import type { HostAdapter, ModelChoice, ProviderRegistry, SessionService } from '@tenon-app/kernel'
import { originOf } from './approval-routes.js'
import {
  instanceChoiceRefusal,
  instanceRowOf,
  isInstanceId,
  isProbedRow,
} from './custom-vendors/registry.js'
import { readConfig, withConfigLock, writeConfigHeld } from './host/profile.js'
import { selectionOf } from './provider-routes.js'

/**
 * The session's model choice (spec 02 §模型选择; 01 修补 6「给会话选模型」): `session.selectModel`
 * records the choice — the session's `session/model_choice_set`, or the draft's before the session
 * exists — then the new-session default of the profile it was made in and `provider` (the level is
 * never a default); `session.modelChoice` reads what the next Run takes. Both wait for startup
 * recovery; a choice also releases what a switch to a public host held, begun with the chooser's
 * document as its origin.
 *
 * A custom vendor instance offers the rows it lists and no hand-typed id (M6 §列表与上限). Its
 * choice is checked against the `config.json` read inside the profile's lock twice: before the
 * session records it, so a delete of the instance or the row that held the lock first leaves no
 * choice and no default behind, and again before the defaults are written, so a delete that came in
 * between is not undone (M6 §写入规则「删除」; 验收 25). The session's command itself runs outside the
 * lock, as before M6 (provider.ts `readSettledInputs`: nothing on the send path holds it).
 *
 * `session.modelChoice` answers an instance's `capabilitySource` by the row `config.json` lists now —
 * `probed` while it passed, else `user` — as `assemble` does (M6 §运行时「行标记」): the five layers
 * give an instance's row `builtin`, as a row of its definition's table.
 */
export interface ModelRoutesDeps {
  readonly ipcMain: IpcMainLike
  readonly sessions: SessionService | null
  readonly providers: ProviderRegistry
  readonly host: Pick<HostAdapter, 'fs' | 'identity'>
  readonly gate?: Promise<void>
}

export function registerModelRoutes(deps: ModelRoutesDeps): void {
  const { ipcMain, sessions, providers, host, gate } = deps

  registerRoute(ipcMain, sessionSelectModel, async (q, event) => {
    await gate
    if (sessions === null) throw new Error('no session store: nothing to choose a model for')
    const definition = providers.get(q.providerId)
    if (definition === null) return refused('unknown-provider')
    const row = definition.builtinModels.find((model) => model.id === q.modelId)
    // M6 §列表与上限: an instance's rows carry the limits the user set; there is no hand-typed one.
    if (row === undefined && isInstanceId(q.providerId)) return refused('unknown-model')
    // A level the row does not list is refused; a hand-typed id lists none (A11, M6).
    const levels = row?.thinkingSpec?.effortLevels ?? []
    if (q.effort !== null && !levels.includes(q.effort)) return refused('invalid-value')
    const selection = selectionOf(definition, q.modelId)
    // An instance's row as the lock leaves it: a delete that held the lock first refuses the choice
    // before the session records it (M6 §写入规则「删除」; 验收 25).
    if (isInstanceId(q.providerId)) {
      const gone = await withConfigLock(host.identity, async () =>
        instanceChoiceRefusal(await readConfig(host.fs, host.identity), q.providerId, q.modelId),
      )
      if (gone !== null) return refused(gone)
    }
    // Outside the lock: the command waits behind a send still prebuilding, whose keychain read may
    // be a prompt on an unsigned build, and that must not hold every save (provider.ts).
    const { profile } = await sessions.selectModel({
      sessionId: q.sessionId,
      choice: {
        providerId: q.providerId,
        modelId: q.modelId,
        effort: q.effort,
        ...(selection.source === undefined ? {} : { source: selection.source }),
      },
      origin: originOf(event),
    })
    await withConfigLock(host.identity, async () => {
      const config = await readConfig(host.fs, host.identity)
      // A delete since the check above came after this choice: it cleared the defaults, and they
      // stay cleared. The session's own choice is a removed instance's, as after any delete (T12).
      if (instanceChoiceRefusal(config, q.providerId, q.modelId) !== null) return
      // Every writer of `config.json` holds this lock, so `config` is still the file's content.
      await writeConfigHeld(host.fs, host.identity, {
        defaultModelByProfile: { ...config.defaultModelByProfile, [profile]: selection },
        provider: selection,
      })
    })
    return SAVED
  })

  registerRoute(ipcMain, sessionModelChoice, async ({ sessionId }) => {
    await gate
    if (sessions === null) throw new Error('no session store: no model choice to read')
    const choice = await sessions.effectiveModelChoice({ sessionId })
    return {
      providerId: choice.providerId,
      modelId: choice.modelId,
      effort: choice.effort,
      capabilitySource: await capabilityOf(choice),
    }
  })

  /** M6 §运行时「行标记」: an instance's row as `config.json` lists it now; a builtin's as chosen. */
  async function capabilityOf(choice: ModelChoice): Promise<ModelChoice['capabilitySource']> {
    if (!isInstanceId(choice.providerId)) return choice.capabilitySource
    const config = await readConfig(host.fs, host.identity)
    const row = instanceRowOf(config, choice.providerId, choice.modelId)
    return row !== null && isProbedRow(row) ? 'probed' : 'user'
  }
}

const SAVED: ProviderWriteResult = { ok: true }

function refused(code: Extract<ProviderWriteResult, { ok: false }>['code']): ProviderWriteResult {
  return { ok: false, code, configKey: null }
}
