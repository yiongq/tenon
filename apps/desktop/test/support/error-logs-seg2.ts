/**
 * What segment two of docs/features/error-logs adds to `log/watch.ts` (spec §接口): the two
 * watchers of process exits and of what nobody caught. The tests import them from here, so the
 * line that has to change when they exist is in one place. (`log/startup-failure.ts` is the other
 * new module; `error-logs-startup.ts` re-exports it.)
 *
 * The `@ts-expect-error` line below exists only because those names were not written when the
 * tests were (test author and implementer are different agents): it turns the missing-export error
 * into an expected one so the repo's typecheck stays green meanwhile, and the names re-exported
 * from it are `any`. When the code lands, tsc reports the directive as unused: delete that
 * directive and nothing else; every call in the tests is annotated by hand, so the real types
 * apply unchanged.
 */
export { watchProcessExits, watchUncaught } from '../../src/main/log/watch.js'
