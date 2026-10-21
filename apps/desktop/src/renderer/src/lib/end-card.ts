import type { RunEndReasonContract, ToolOutcomeViewContract } from '@tenon-app/contracts'
import type { ToolPart } from '../runtime/thread-model'
import { toolObject } from './tool-sentence'

type Code = RunEndReasonContract['code']
export type EndVisual = 'neutral' | 'danger' | 'warning'
export type EndAction = 'continue' | 'retry' | 'settings' | 'copy'

/**
 * What a Run's end shows (spec 02 §失败卡与结束原因): an exhaustive switch over every end code — one
 * the switch forgets does not compile — to its visual class and its one action. `completed` has the
 * summary line only; `paused` shows nothing, the card or the question being in view.
 */
export function cardOf(
  reason: RunEndReasonContract,
  retryable: boolean,
): { readonly visual: EndVisual; readonly action: EndAction } | null {
  const code: Code = reason.code
  switch (code) {
    case 'completed':
    case 'paused':
    case 'user-rejected':
      return null
    case 'step-limit':
    case 'output-truncated':
      return { visual: 'neutral', action: 'continue' }
    case 'user-stopped':
    case 'shutdown-aborted':
    case 'usage-limit':
    case 'recovered':
    case 'time-limit':
      return { visual: 'neutral', action: 'copy' }
    case 'blocked-repeatedly':
      return { visual: 'warning', action: 'copy' }
    case 'provider-error':
      if (reason.code === 'provider-error' && reason.errorCode === 'auth') {
        return { visual: 'danger', action: 'settings' }
      }
      return { visual: 'danger', action: retryable ? 'retry' : 'copy' }
    case 'refusal':
    case 'content-filter':
    case 'context-overflow':
    case 'no-progress':
    case 'quota-exhausted':
    case 'account-config':
      return { visual: 'danger', action: 'copy' }
    default: {
      const unhandled: never = code
      return unhandled
    }
  }
}

/** Where one call of the round goes in ② of the card (§失败卡与结束原因). */
export type EffectLine = 'done' | 'stopped' | 'stopped-sent' | 'not-run' | 'uncertain'

/**
 * One call's line in ② (§失败卡与结束原因, §点停止时各状态怎么收): a call stopped part-way says its
 * later writes did not happen — for a command, `aborted` is written only once its `exited` came within
 * the confirmation window, after the SIGKILL of its whole group, so the line never shows while the
 * tree still runs — and a request already in flight (WebSearch, WebFetch, a connector's tool: effect
 * `external`) may have reached the other side, so it never says that. Bash's effect is `external` too
 * (§内置工具与参数), but it is a command, not a request.
 */
export function effectLineOf(
  name: string,
  outcome: Pick<ToolOutcomeViewContract, 'state' | 'effect'>,
): EffectLine {
  switch (outcome.state) {
    case 'completed':
      return 'done'
    case 'aborted':
      return outcome.effect === 'external' && name !== 'Bash' ? 'stopped-sent' : 'stopped'
    case 'not-run':
      return 'not-run'
    default:
      return 'uncertain'
  }
}

/** Provider failures use the existing error vocabulary; null is the unknown case. */
export function providerErrorKey(
  errorCode: Extract<RunEndReasonContract, { code: 'provider-error' }>['errorCode'],
): string {
  return `runEnd.provider-error.${errorCode ?? 'unknown'}`
}

export interface DoneGroup {
  readonly part: ToolPart
  readonly object: string
  readonly fullObject: string
  count: number
}

/** Group by tool and complete object before shortening file names, in first-seen order. */
export function aggregateDone(parts: readonly ToolPart[]): {
  readonly visible: readonly DoneGroup[]
  readonly folded: readonly DoneGroup[]
} {
  const groups = new Map<string, DoneGroup>()
  const paths = new Map<string, Set<string>>()
  for (const part of parts) {
    const fullObject = toolObject(part.name, part.input)
    const file = ['Read', 'Write', 'Edit'].includes(part.name)
    const object = file ? (fullObject.split('/').at(-1) ?? fullObject) : fullObject
    if (file) {
      const matches = paths.get(object) ?? new Set<string>()
      matches.add(fullObject)
      paths.set(object, matches)
    }
    const key = JSON.stringify([part.name, fullObject])
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { part, object, fullObject, count: 1 })
  }
  const all = [...groups.values()].map((group) =>
    ['Read', 'Write', 'Edit'].includes(group.part.name) && (paths.get(group.object)?.size ?? 0) > 1
      ? {
          part: group.part,
          object: group.fullObject,
          fullObject: group.fullObject,
          count: group.count,
        }
      : group,
  )
  return { visible: all.slice(0, 5), folded: all.slice(5) }
}
