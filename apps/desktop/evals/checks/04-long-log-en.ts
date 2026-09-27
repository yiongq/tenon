/**
 * 04 · the English long output (H9): `node run-tests.mjs` prints about 46 000 characters of a test
 * run; its one real failure (`✗`, not the flaky `↻` ones that passed on retry), about 39 000
 * characters in, carries the test ID. The fixture test pins both numbers and this answer to the
 * script's output.
 */
import { longLogCheck } from './long-log.js'

export const ANSWER = 'SY-2595'

export default longLogCheck({ command: /\brun-tests\.mjs\b/, answer: ANSWER })
