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
        case 'pass':
          return { kind: 'none' }
        case 'blocked':
          return {
            kind: 'deny',
            category: 'control-characters',
            findings: [{ code: 'control-characters' }],
          }
        case 'modified':
          return {
            kind: 'ask',
            category: 'hidden-characters',
            findings: [{ code: 'hidden-characters' }],
          }
        default:
          throw new Error('unexpected input hygiene verdict')
      }
    },
  }
}
