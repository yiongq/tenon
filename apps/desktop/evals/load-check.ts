/**
 * The loader for a task's script checks (spec 02 §评测集与测试宿主): `checks/<id>.ts` default-exports
 * an `EvalCheck`. The id is a task's own word for its check, so it is held to `CHECK_ID_PATTERN` —
 * no path can be spelled with it — before anything is imported.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EvalCheck } from './task.js'
import { CHECK_ID_PATTERN } from './task.js'

/** `apps/desktop/evals/checks/`: where the tasks' checks live. */
export const CHECKS_DIR = join(import.meta.dirname, 'checks')

export async function loadCheck(id: string, dir: string = CHECKS_DIR): Promise<EvalCheck> {
  if (!CHECK_ID_PATTERN.test(id)) throw new Error(`not a check id: ${JSON.stringify(id)}`)
  const file = join(dir, `${id}.ts`)
  if (!existsSync(file)) throw new Error(`no script check ${id} (${file})`)
  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown }
  if (typeof loaded.default !== 'function') {
    throw new Error(`checks/${id}.ts has no default export of an EvalCheck`)
  }
  return loaded.default as EvalCheck
}
