/** The local, ask-only exfiltration rule (spec 02 F5); all evidence comes from the Tape view. */
import type { AskOpinion, InspectorRegistration } from './inspector.js'
import type { BeforeCallInput } from './session-view.js'

export function exfiltrationOpinion({ call, view }: BeforeCallInput): AskOpinion {
  return call.tool.source === 'builtin' &&
    call.tool.originalName === 'WebFetch' &&
    view.touchedPrivateData &&
    view.untrustedSources.length > 0 &&
    view.fetchUrlVouched !== true
    ? { kind: 'ask', category: 'exfiltration', findings: [{ code: 'lethal-trifecta' }] }
    : { kind: 'none' }
}

export const exfiltrationInspector: InspectorRegistration = {
  id: 'exfiltration',
  ceiling: 'ask',
  kind: 'local-rule',
  beforeCall: (input) => Promise.resolve(exfiltrationOpinion(input)),
}
