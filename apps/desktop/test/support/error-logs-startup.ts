/**
 * What segment two of docs/features/error-logs adds in `log/startup-failure.ts` (spec §接口): the
 * start-failure report and the opener of the log folder. The tests import them from here, so the
 * line that has to change when the module exists is in one place.
 */
export { openLogsFolder, reportStartupFailure } from '../../src/main/log/startup-failure.js'
