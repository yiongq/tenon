import type { EvalCheck } from './types.js'
import { jsonReply } from './task-data.js'
import { callsOf, readSession } from './support.js'
const check: EvalCheck = async (ctx) => {
  const result = await jsonReply([
    { name: 'Aster', url: 'https://catalog.example.test/aster' },
    { name: 'Birch', url: 'https://catalog.example.test/birch' },
  ])(ctx)
  const calls = callsOf(await readSession(ctx.tape, ctx.sessionId))
  const successful = calls.filter(
    (c) =>
      c.name === 'WebSearch' && c.result?.isError === false && c.outcome?.state === 'completed',
  )
  return {
    pass: result.pass && successful.length >= 1,
    note: result.note + '; successful source calls=' + successful.length,
  }
}
export default check
