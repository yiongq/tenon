import { serverIdOfMappedName } from '@tenon-app/contracts'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
export function toolRowEffect(outcome: ToolOutcomeViewContract | null, toolName: string) {
  if (!outcome) return null
  const reversibility = outcome.reversibility ?? 'unknown'
  return {
    effectKey: `mcp.effects.${outcome.effect}` as const,
    reversibilityKey: `mcp.reversibility.${reversibility}` as const,
    marker:
      (outcome.effect === 'write' || outcome.effect === 'external') &&
      (reversibility === 'irreversible' || reversibility === 'unknown'),
    loginServerId:
      outcome.source === 'connector-unauthorized' ? serverIdOfMappedName(toolName) : null,
  }
}
