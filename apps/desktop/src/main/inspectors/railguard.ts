/** Spec 06: only input hygiene, on original command/path parameters. Never apply transformed text. */
import { inputHygiene } from '@yiong/railguard/rules'
import type { InspectorRegistration } from '@tenon-app/kernel'

const PARAMETERS: Readonly<Record<string, string>> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Delete: 'file_path',
  Glob: 'path',
  Grep: 'path',
}

/**
 * Two classes railguard 0.7.0 does not report, checked here and only ever tightening (06 D39): C1
 * control characters block like C0 ones, and bidirectional controls, which can turn a name around
 * on screen, ask like zero-width ones. Other format characters stay a known limit.
 */
const C1_CONTROL = /[\u0080-\u009F]/u
const BIDI_CONTROL = /\p{Bidi_Control}/u

const CONTROL = {
  kind: 'deny',
  category: 'control-characters',
  findings: [{ code: 'control-characters' }],
} as const
const HIDDEN = {
  kind: 'ask',
  category: 'hidden-characters',
  findings: [{ code: 'hidden-characters' }],
} as const

export function railguardInspector(): InspectorRegistration {
  const hygiene = inputHygiene('beforeToolCall')
  return {
    id: 'input-hygiene',
    ceiling: 'deny',
    kind: 'local-rule',
    beforeCall: async ({ call }) => {
      if (call.tool.source !== 'builtin') return { kind: 'none' }
      const parameter = PARAMETERS[call.tool.originalName]
      const value = parameter === undefined ? undefined : call.args[parameter]
      if (typeof value !== 'string') return { kind: 'none' }
      const outcome = await hygiene.check(value, {
        requestId: 'input-hygiene',
        trace: [],
        taint: { untrustedSources: [], touchedPrivateData: false, externalCommsRequested: false },
        kv: new Map(),
      })
      if (outcome.status !== 'ok') throw new Error('input hygiene did not complete')
      switch (outcome.verdict) {
        case 'blocked':
          return CONTROL
        case 'pass':
        case 'modified':
          if (C1_CONTROL.test(value)) return CONTROL
          return outcome.verdict === 'modified' || BIDI_CONTROL.test(value)
            ? HIDDEN
            : { kind: 'none' }
        default:
          throw new Error('unexpected input hygiene verdict')
      }
    },
  }
}
