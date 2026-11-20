/** Product checks for spec 06, shipped with inspector receipt release in the same segment. */
import { exfiltrationInspector } from '@tenon-app/kernel'
import type { InspectorRegistration } from '@tenon-app/kernel'
import { railguardInspector } from './inspectors/railguard.js'

export function desktopInspectors(): readonly InspectorRegistration[] {
  return [exfiltrationInspector, railguardInspector()]
}
