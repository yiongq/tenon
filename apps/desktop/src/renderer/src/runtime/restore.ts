/**
 * How much of a stored conversation a window opens on (spec 01 验收 5).
 *
 * The tail, not the whole history: what the window opens on is the end of the last conversation,
 * and `session.messages` pages backwards from there when phase 6 adds the scrollback. 200 is
 * generous for a screenful and well inside the port's own bound. The rows themselves become the
 * thread through `threadFromRows` and `toThreadMessages` (spec 02 plan step 20).
 */
export const RESTORE_LIMIT = 200
