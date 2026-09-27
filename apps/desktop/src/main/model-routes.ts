import { registerRoute, sessionModelChoice, sessionSelectModel } from '@tenon-app/contracts'
import type { IpcMainLike, ProviderWriteResult } from '@tenon-app/contracts'
import type { HostAdapter, ProviderRegistry, SessionService } from '@tenon-app/kernel'
import { originOf } from './approval-routes.js'
import { readConfig, withConfigLock, writeConfigHeld } from './host/profile.js'
import { selectionOf } from './provider-routes.js'

/**
 * The session's model choice (spec 02 §模型选择; 01 修补 6「给会话选模型」): `session.selectModel`
 * records the choice — the session's `session/model_choice_set`, or the draft's before the session
 * exists — then the new-session default of the profile it was made in and `provider` (the level is
 * never a default); `session.modelChoice` reads what the next Run takes. Both wait for startup
 * recovery; a choice also releases what a switch to a public host held, begun with the chooser's
 * document as its origin.
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
    // A level the row does not list is refused; a hand-typed id lists none (A11, M6).
    const row = definition.builtinModels.find((model) => model.id === q.modelId)
    const levels = row?.thinkingSpec?.effortLevels ?? []
    if (q.effort !== null && !levels.includes(q.effort)) return refused('invalid-value')
    const selection = selectionOf(definition, q.modelId)
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
      capabilitySource: choice.capabilitySource,
    }
  })
}

const SAVED: ProviderWriteResult = { ok: true }

function refused(code: Extract<ProviderWriteResult, { ok: false }>['code']): ProviderWriteResult {
  return { ok: false, code, configKey: null }
}
