/**
 * Spec 04 §依赖: desktop depends on sandbox-runtime pinned to exactly 0.0.79 (T2; an upgrade goes
 * through the spec's Revisions), and only the desktop sandbox module imports it — kernel, contracts
 * and the renderer never do (04 不变量 12, the import half; §所有权与模块 names the four files).
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { helperPaths } from '../../src/main/host/sandbox-config.js'

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

/** Spec 04 §所有权与模块: 「srt 只在这几个文件里 import」. */
const MAY_IMPORT_SRT = new Set([
  'apps/desktop/src/main/host/sandbox.ts',
  'apps/desktop/src/main/host/sandbox-config.ts',
  'apps/desktop/src/main/host/sandbox-posture.ts',
  'apps/desktop/src/main/host/sandbox-violations.ts',
])

describe('04 sandbox-runtime dependency', () => {
  it('04 验收 1: desktop pins sandbox-runtime 0.0.79 exactly', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@anthropic-ai/sandbox-runtime']).toBe('0.0.79')

    // What actually runs, resolved from the desktop sandbox module's directory the way its helper
    // paths are (spec §依赖): an override or a stale install under the exact pin fails here.
    const installed = createRequire(
      join(repo, 'apps/desktop/src/main/host/sandbox-config.ts'),
    ).resolve('@anthropic-ai/sandbox-runtime/package.json')
    const { version } = JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }
    expect(version).toBe('0.0.79')
  })

  it('04 验收 1: the helper paths resolve to real files', () => {
    const helpers = helperPaths()
    // srt's package dir, as a real path (spec §依赖: the dir behind node_modules' link).
    expect(realpathSync(helpers.packageDir)).toBe(helpers.packageDir)
    const manifest = JSON.parse(readFileSync(join(helpers.packageDir, 'package.json'), 'utf8')) as {
      name?: string
      version?: string
    }
    expect(manifest).toMatchObject({ name: '@anthropic-ai/sandbox-runtime', version: '0.0.79' })
    // The two helpers srt is handed explicitly (T31), in their places in the package.
    expect(helpers.applySeccomp).toBe(
      `${helpers.packageDir}/vendor/seccomp/${process.arch}/apply-seccomp`,
    )
    expect(helpers.javaAgentJar).toBe(
      `${helpers.packageDir}/vendor/java-proxy-agent/srt-proxy-agent.jar`,
    )
    expect(statSync(helpers.applySeccomp).isFile()).toBe(true)
    expect(statSync(helpers.javaAgentJar).isFile()).toBe(true)
  })

  it('04 不变量 12: only apps/desktop/src/main/host/sandbox*.ts import sandbox-runtime', () => {
    const packages = readdirSync(join(repo, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/src`)
    // The eval host is to use DesktopSandbox (spec 04 §三处调用点与档位「评测」, 读法 26), never srt
    // itself. Its tests and their support are left out, as apps/desktop/test is.
    const evals = sourcesUnder('apps/desktop/evals').filter(
      (file) => !file.startsWith('apps/desktop/evals/test/') && !/\.test\.[^/]+$/.test(file),
    )
    const files = [...packages.flatMap(sourcesUnder), ...sourcesUnder('apps/desktop/src'), ...evals]
    // The walk reaches the places the invariant names and the eval host, so an empty walk cannot
    // pass.
    expect(files).toContain('packages/kernel/src/index.ts')
    expect(files).toContain('packages/contracts/src/index.ts')
    expect(files).toContain('apps/desktop/src/renderer/src/main.tsx')
    expect(files).toContain('apps/desktop/evals/host.ts')

    const importers = files.filter((file) => NAMES_SRT.test(readFileSync(join(repo, file), 'utf8')))
    expect(importers.filter((file) => !MAY_IMPORT_SRT.has(file))).toEqual([])
  })
})
