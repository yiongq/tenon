/**
 * Acceptance 8, the half lint cannot see: a dependency that statically reaches a `node:`
 * built-in is invisible to no-restricted-imports but fatal to a non-Node host. Bundling
 * both kernel entry points with platform 'browser' is the assertion.
 *
 * 'browser', not 'neutral': the Anthropic SDK's legacy top-level `browser` field swaps
 * internal/node.mjs for a stub, and only the browser platform applies it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const kernelDir = fileURLToPath(new URL('../', import.meta.url))

interface BuildFailureLike {
  readonly errors?: readonly {
    readonly text: string
    readonly location?: { file?: string } | null
  }[]
}

function errorTexts(error: unknown): string[] {
  const errors = (error as BuildFailureLike).errors
  if (errors === undefined) return [String(error)]
  return errors.map((e) => `${e.text} (${e.location?.file ?? 'unknown file'})`)
}

async function bundleErrors(entry: string): Promise<string[]> {
  try {
    const result = await build({
      entryPoints: [`${kernelDir}${entry}`],
      absWorkingDir: kernelDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    })
    return result.errors.map((e) => e.text)
  } catch (error) {
    return errorTexts(error)
  }
}

/** The same build, for a dependency no kernel file imports yet. */
async function bundleImportErrors(module: string): Promise<string[]> {
  try {
    const result = await build({
      stdin: {
        contents: `import mod from '${module}'\nexport default mod\n`,
        resolveDir: kernelDir,
        sourcefile: 'dependency-probe.ts',
        loader: 'ts',
      },
      absWorkingDir: kernelDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    })
    return result.errors.map((e) => e.text)
  } catch (error) {
    return errorTexts(error)
  }
}

describe('kernel host independence', () => {
  it('bundles the public entry with no node: built-in reachable', async () => {
    expect(await bundleErrors('src/index.ts')).toEqual([])
  }, 60_000)

  it('bundles the testing entry with no node: built-in reachable', async () => {
    expect(await bundleErrors('src/testing/index.ts')).toEqual([])
  }, 60_000)

  it('bundles the pinned provider SDKs, including one no entry reaches yet', async () => {
    // `openai` is a kernel dependency from step 10 on, but nothing imports it until the
    // OpenAI-compatible adapter's stream() lands — so the pin would otherwise sit unproven
    // against acceptance 8 until then, which is exactly when a `node:` reach would be expensive.
    expect(await bundleImportErrors('openai')).toEqual([])
    expect(await bundleImportErrors('@anthropic-ai/sdk')).toEqual([])
  }, 60_000)

  it('depends on neither better-sqlite3 nor electron', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    const groups = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const
    const named = manifest as Record<string, Record<string, string> | undefined>
    for (const group of groups) {
      const deps = Object.keys(named[group] ?? {})
      expect(deps).not.toContain('better-sqlite3')
      expect(deps).not.toContain('electron')
    }
  })
})
