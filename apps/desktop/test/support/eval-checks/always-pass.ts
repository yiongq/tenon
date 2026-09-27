/** A script check for the runner's offline test that passes whatever the run did. */
import type { EvalCheck } from '../../../evals/task.js'

const check: EvalCheck = async () => ({ pass: true, note: '' })

export default check
