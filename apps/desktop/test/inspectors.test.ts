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

  it('02 不变量 17: keeps the receipt-override literals where nothing writes them', () => {
    // Spec 04 §放行的记法 and 点名 (g): the `via` member of `ApprovalResolvedPayload` keeps no
    // writer, and only `release` writes `tool/receipt_override`. Until plan step 11 lands that
    // writer, both literals appear only in their type declarations and the name's registrations.
    const mentions = (literal: string): string[] =>
      [...sources('packages/kernel/src'), ...sources('apps/desktop/src')].flatMap((file) =>
        readFileSync(join(REPO, file), 'utf8')
          .split('\n')
          .flatMap((line) => (line.includes(literal) ? [`${file}: ${line.trim()}`] : [])),
      )
    expect(mentions("'receipt-override'")).toEqual([
      "packages/kernel/src/tape/entry.ts: via: 'receipt-override'",
      expect.stringMatching(/^packages\/kernel\/src\/tape\/entry\.ts: via: 'card' \|/),
    ])
    expect(mentions("'tool/receipt_override'")).toEqual([
      "packages/kernel/src/tape/names.ts: name: 'tool/receipt_override',",
      "packages/kernel/src/tape/projection.ts: 'tool/receipt_override': ReceiptOverridePayload",
    ])
  })
})
