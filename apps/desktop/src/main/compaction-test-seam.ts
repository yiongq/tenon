/** Development-only compaction threshold seam (spec 02 §评测集与测试宿主, step 30). */
export const COMPACTION_THRESHOLD_ENV = 'TENON_E2E_COMPACTION_THRESHOLD'

export function compactionTestOptions(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): { compactionThreshold?: number } {
  // A packaged build does not even read the ambient value.
  if (isPackaged) return {}
  const raw = env[COMPACTION_THRESHOLD_ENV]
  if (raw === undefined || !/^\d+$/.test(raw)) return {}
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? { compactionThreshold: value } : {}
}
