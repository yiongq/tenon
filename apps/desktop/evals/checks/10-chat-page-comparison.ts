import type { EvalCheck } from './types.js'
import { jsonReply } from './task-data.js'
import { callsOf, readSession } from './support.js'
const check: EvalCheck = async (ctx) => {
  const result = await jsonReply({ heavier: 'b', differenceGrams: 250 })(ctx)
  const calls = callsOf(await readSession(ctx.tape, ctx.sessionId))
  const successful = calls.filter(
    (c) => c.name === 'WebFetch' && c.result?.isError === false && c.outcome?.state === 'completed',
  )
  return {
    pass:
      result.pass &&
      ['a', 'b'].every((id) =>
        successful.some((c) => c.input['url'] === `https://compare.example.test/${id}`),
      ),
    note: result.note + '; successful source calls=' + successful.length,
  }
}
export default check
