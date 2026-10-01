import type { EvalCheck } from './types.js'
import { readSession, callsOf } from './support.js'
import { jsonFile } from './task-data.js'
const check: EvalCheck = async (ctx) => {
  const entries = await readSession(ctx.tape, ctx.sessionId)
  const link = entries.find((e) => e.name === 'session/parent_link')
  const childId = (link?.payload['child'] as { sessionId?: string } | undefined)?.sessionId
  const child = childId ? await readSession(ctx.tape, childId) : []
  const result = await jsonFile('audit.json', { unpaidTotal: 90, ids: ['i2', 'i3'] })(ctx)
  const handed = entries.some(
    (e) =>
      e.name === 'tool/result' &&
      (e.payload['handoff'] as { outcome?: string } | undefined)?.outcome === 'completed',
  )
  const read = callsOf(child).some(
    (c) =>
      c.name === 'Read' &&
      String(c.input['file_path']).endsWith('invoices.json') &&
      c.result?.isError === false,
  )
  return {
    pass:
      result.pass &&
      handed &&
      read &&
      !callsOf(entries).some(
        (c) => c.name === 'Read' && String(c.input['file_path']).endsWith('invoices.json'),
      ),
    note: `Child actual Read=${read}; completed handoff=${handed}; child calls=${callsOf(child).length}; ${result.note}`,
  }
}
export default check
