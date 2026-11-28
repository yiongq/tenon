/**
 * What segment two of docs/features/error-logs adds to `log/watch.ts` (spec §接口): the two
 * watchers of process exits and of what nobody caught. The tests import them from here, so the
 * line that has to change when they exist is in one place. (`log/startup-failure.ts` is the other
 * new module; `error-logs-startup.ts` re-exports it.)
 */
export { watchProcessExits, watchUncaught } from '../../src/main/log/watch.js'
