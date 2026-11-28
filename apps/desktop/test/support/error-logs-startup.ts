/**
 * What segment two of docs/features/error-logs adds in `log/startup-failure.ts` (spec §接口): the
 * start-failure report and the opener of the log folder. The tests import them from here, so the
 * line that has to change when the module exists is in one place.
 *
 * The `@ts-expect-error` line below exists only because the module was not written when the tests
 * were (test author and implementer are different agents): it turns the missing-module error into
 * an expected one so the repo's typecheck stays green meanwhile, and the names re-exported from it
 * are `any`. When the module lands, tsc reports the directive as unused: delete that directive and
 * nothing else; every call in the tests is annotated by hand, so the real types apply unchanged.
 */
// @ts-expect-error — log/startup-failure.ts does not exist until error-logs segment 2 is implemented
export { openLogsFolder, reportStartupFailure } from '../../src/main/log/startup-failure.js'
