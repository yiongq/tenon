/**
 * The desktop inspector ceilings and their dedicated receipt writers (spec 02 §Inspector 接口与合议, §不变量 权限; F1,
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
  it('06 验收 23: desktop registers exfiltration (ask) and hygiene (deny) only', () => {
    const inspectors = desktopInspectors()
    expect(inspectors).toHaveLength(2)
    expect(inspectors[0]).toBe(exfiltrationInspector)
    expect(
      inspectors.map(({ id, ceiling, kind, afterResult }) => ({ id, ceiling, kind, afterResult })),
    ).toEqual([
      { id: 'exfiltration', ceiling: 'ask', kind: 'local-rule', afterResult: undefined },
      { id: 'input-hygiene', ceiling: 'deny', kind: 'local-rule', afterResult: undefined },
    ])
  })

  it('02 不变量 17: only release writes receipt overrides, never approval answers', () => {
    // Spec 04 §放行的记法 and 点名 (g): the `via` member of `ApprovalResolvedPayload` keeps no
    // writer, and only the receipt release implementation may write the new fact.
    const mentions = (literal: string): string[] =>
      [...sources('packages/kernel/src'), ...sources('apps/desktop/src')]
        .filter((file) => !file.startsWith('packages/kernel/src/testing/'))
        .flatMap((file) =>
          readFileSync(join(REPO, file), 'utf8')
            .split('\n')
            .flatMap((line) => (line.includes(literal) ? [`${file}: ${line.trim()}`] : [])),
        )
    expect(mentions("'receipt-override'")).toEqual([
      "packages/kernel/src/permission/inspector-release.ts: via: 'receipt-override',",
      "packages/kernel/src/permission/sandbox-release.ts: via: 'receipt-override',",
      "packages/kernel/src/tape/entry.ts: via: 'receipt-override'",
      "packages/kernel/src/tape/entry.ts: via: 'receipt-override'",
      "packages/kernel/src/tape/entry.ts: via: 'card' | 'stop' | 'new-message' | 'rejudge' | 'receipt-override' // 'receipt-override' 在 02 没有写入方（F9、F1）",
    ])
    expect(mentions("'tool/receipt_override'")).toEqual([
      "packages/kernel/src/permission/sandbox-release.ts: const RECEIPT_OVERRIDE = 'tool/receipt_override'",
      "packages/kernel/src/tape/names.ts: name: 'tool/receipt_override',",
      "packages/kernel/src/tape/projection.ts: 'tool/receipt_override': ReceiptOverridePayload",
    ])
    expect(mentions("'tool/inspector_override'")).toEqual([
      "packages/kernel/src/permission/inspector-release.ts: const INSPECTOR_OVERRIDE = 'tool/inspector_override'",
      "packages/kernel/src/tape/names.ts: name: 'tool/inspector_override',",
      "packages/kernel/src/tape/projection.ts: 'tool/inspector_override': InspectorOverridePayload",
    ])
  })
})
