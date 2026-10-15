/**
 * Spec 04 §依赖: desktop depends on sandbox-runtime pinned to exactly 0.0.79 (T2; an upgrade goes
 * through the spec's Revisions), and only the desktop sandbox module imports it — kernel, contracts
 * and the renderer never do (04 不变量 12, the import half).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/

/** Every source file under a directory, as a repo-relative path with forward slashes. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(join(repo, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => SOURCE_EXTENSIONS.test(file))
    .map((file) => `${dir}/${file.split('\\').join('/')}`)
}

/**
 * The module named as a string anywhere in the text: static and dynamic imports, re-exports,
 * `require` and `createRequire(...).resolve`, with or without a subpath. A comment that quotes it
 * also counts, which errs on the safe side.
 */
const NAMES_SRT = /['"`]@anthropic-ai\/sandbox-runtime(?:\/[^'"`]*)?['"`]/

describe('04 sandbox-runtime dependency', () => {
  it('04 验收 1: desktop pins sandbox-runtime 0.0.79 exactly', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@anthropic-ai/sandbox-runtime']).toBe('0.0.79')
  })

  it('04 不变量 12: only apps/desktop/src/main/host/sandbox*.ts import sandbox-runtime', () => {
    const packages = readdirSync(join(repo, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/src`)
    const files = [...packages.flatMap(sourcesUnder), ...sourcesUnder('apps/desktop/src')]
    // The walk reaches the three places the invariant names, so an empty walk cannot pass.
    expect(files).toContain('packages/kernel/src/index.ts')
    expect(files).toContain('packages/contracts/src/index.ts')
    expect(files).toContain('apps/desktop/src/renderer/src/main.tsx')

    const importers = files.filter((file) => NAMES_SRT.test(readFileSync(join(repo, file), 'utf8')))
    const outside = importers.filter(
      (file) => !/^apps\/desktop\/src\/main\/host\/sandbox[^/]*\.ts$/.test(file),
    )
    expect(outside).toEqual([])
  })
})
