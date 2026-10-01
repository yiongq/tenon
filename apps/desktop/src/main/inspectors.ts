/**
 * The inspectors the desktop registers (spec 02 §Inspector 接口与合议, §外带检查; F1, F5, F9).
 *
 * Phase 2's product registers exactly one, the exfiltration rule the kernel exports, and it only ever
 * asks; it joins with WebFetch (plan step 29). The first inspector that may DENY must ship in the same
 * change as overriding a block from its receipt (F9): inspectors.test.ts pins that every registration
 * here asks, and the commit that changes that test has to carry the override with it.
 */
import { exfiltrationInspector } from '@tenon-app/kernel'
import type { InspectorRegistration } from '@tenon-app/kernel'

export function desktopInspectors(): readonly InspectorRegistration[] {
  return [exfiltrationInspector]
}
