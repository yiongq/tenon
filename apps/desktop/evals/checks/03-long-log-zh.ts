/**
 * 03 · the Chinese long output (H9): `node nightly.mjs` prints about 45 000 characters of a nightly
 * build log; its one `[错误]` line, about 37 000 characters in, carries the error code. The fixture
 * test pins both numbers and this answer to the script's output.
 */
import { longLogCheck } from './long-log.js'

export const ANSWER = 'E-6801'

export default longLogCheck({ command: /\bnightly\.mjs\b/, answer: ANSWER })
