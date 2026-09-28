import { readFile } from 'node:fs/promises'
import type { EvalCheck } from './types.js'
import { fixturePath, readText, runNode, callsOf, readSession, succeeded } from './support.js'
const check: EvalCheck = async (ctx) => {
  const unchanged =
    (await readText(ctx.workspaceDir, 'test.mjs')) ===
    (await readFile(fixturePath('16-fix-pagination-boundaries', 'test.mjs'), 'utf8'))
  const probe = await runNode(ctx.workspaceDir, [
    '--input-type=module',
    '--eval',
    `import assert from 'node:assert/strict'; import {pages} from './paginate.js'; for(const n of [1,2,3,7]) {const a=[1,2,3,4,5]; const b=pages(a,n); assert.deepEqual(b.flat(),a); assert.deepEqual(a,[1,2,3,4,5]); assert(b.every(p=>p.length>0&&p.length<=n));} for(const n of [0,-1,1.5,NaN]) assert.throws(()=>pages([1],n),RangeError); assert.deepEqual(pages([],3),[])`,
  ])
  const ran = callsOf(await readSession(ctx.tape, ctx.sessionId)).some(
    (c) =>
      c.name === 'Bash' &&
      String(c.input['command']).includes('node test.mjs') &&
      succeeded(c) &&
      c.result?.text.includes('pagination passed'),
  )
  return {
    pass: unchanged && probe.code === 0 && ran,
    note: `Original tests=${unchanged}; hidden boundary probe=${probe.code}; model ran suite=${ran}`,
  }
}
export default check
