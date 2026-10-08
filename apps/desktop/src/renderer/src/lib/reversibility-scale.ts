import type { ConfirmRequestInput } from '@tenon-app/contracts'
export const REVERSIBILITY_SCALE = [
  'read-only',
  'revertible',
  'snapshotted',
  'irreversible',
  'unknown',
] as const
export function reversibilityScale(current: ConfirmRequestInput['reversibility']) {
  return REVERSIBILITY_SCALE.map((value) => ({
    value,
    current: value === current,
    key: `mcp.reversibility.${value}` as const,
  }))
}
