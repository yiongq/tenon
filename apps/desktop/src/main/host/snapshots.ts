import type { HostSnapshots } from '@tenon-app/kernel'

/**
 * Spec 05 §接口: conservative placeholder for plan step 2. Step 4 replaces it with the desktop
 * snapshot subsystem; it never promises coverage or writes the workspace in the meantime.
 */
export const unavailableSnapshots: HostSnapshots = {
  coverage: async () => 'none',
  status: () => 'unavailable',
  take: async (_q, signal) => ({ ok: false, reason: signal.aborted ? 'aborted' : 'not-covered' }),
  preview: async () => {
    throw new Error('Desktop snapshots are unavailable until spec 05 step 4')
  },
  prepare: async () => ({ ok: false, reason: 'undo-unavailable' }),
  apply: async () => {
    throw new Error('Desktop snapshots are unavailable until spec 05 step 4')
  },
  cancel: async () => {},
  alive: async () => new Set<string>(),
}
