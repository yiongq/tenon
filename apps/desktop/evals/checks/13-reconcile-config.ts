import { readFile } from 'node:fs/promises'
import type { EvalCheck } from './types.js'
import { fixturePath, readText } from './support.js'
import { jsonFile } from './task-data.js'
const check: EvalCheck = async (ctx) => {
  const result = await jsonFile('effective.json', { port: 8080, debug: true, region: 'west' })(ctx)
  const sources = await Promise.all(
    ['base.json', 'override.json'].map(
      async (name) =>
        (await readText(ctx.workspaceDir, name)) ===
        (await readFile(fixturePath('13-reconcile-config', name), 'utf8')),
    ),
  )
  return {
    pass: result.pass && sources.every(Boolean),
    note: `${result.note}; input files unchanged=${sources.every(Boolean)}`,
  }
}
export default check
