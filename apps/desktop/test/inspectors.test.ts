/**
 * Every inspector the desktop registers only asks (spec 02 §Inspector 接口与合议, §不变量 权限; F1,
 * F9). A change that makes this fail must also ship overriding a block from its receipt.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exfiltrationInspector } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { desktopInspectors } from '../src/main/inspectors.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** Every TypeScript source file under a folder of the repository, by its path from the root. */
function sources(folder: string): string[] {
  return readdirSync(join(REPO, folder), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(folder, file))
}

describe('the desktop’s inspectors', () => {
  it('02 不变量 17: all register ceiling ask, and none registers the after-result hook', () => {
    for (const inspector of desktopInspectors()) {
      expect({
        id: inspector.id,
        ceiling: inspector.ceiling,
        afterResult: inspector.afterResult,
      }).toEqual({
        id: inspector.id,
        ceiling: 'ask',
        afterResult: undefined,
      })
    }
    expect(desktopInspectors()).toEqual([exfiltrationInspector])
    expect(desktopInspectors()[0]).toMatchObject({
      id: 'exfiltration',
      ceiling: 'ask',
      kind: 'local-rule',
    })
  })

  it('02 不变量 17: keeps the answer source receipt-override as a literal nothing writes', () => {
    // Overriding a block from its receipt ships with the first denying inspector (F9): until then
    // the only mention is the member of `ApprovalResolvedPayload.via` on the Tape's type.
    const mentions = [...sources('packages/kernel/src'), ...sources('apps/desktop/src')].flatMap(
      (file) =>
        readFileSync(join(REPO, file), 'utf8')
          .split('\n')
          .flatMap((line) =>
            line.includes('receipt-override') ? [`${file}: ${line.trim()}`] : [],
          ),
    )
    expect(mentions).toHaveLength(1)
    expect(mentions[0]).toMatch(/^packages\/kernel\/src\/tape\/entry\.ts: via: 'card' \|/)
  })
})
