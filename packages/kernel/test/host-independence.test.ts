/**
 * Acceptance 8, the half lint cannot see: a dependency that statically reaches a `node:`
 * built-in is invisible to no-restricted-imports but fatal to a non-Node host. Bundling
 * both kernel entry points with platform 'browser' is the assertion.
 *
 * 'browser', not 'neutral': the Anthropic SDK's legacy top-level `browser` field swaps
 * internal/node.mjs for a stub, and only the browser platform applies it.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build, transformSync } from 'esbuild'
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
async function bundleImportErrors(module: string, imported = 'default'): Promise<string[]> {
  try {
    const result = await build({
      stdin: {
        contents: `import { ${imported} as mod } from '${module}'\nexport default mod\n`,
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

/** Every TypeScript source under a kernel directory, recursively, with its text. */
function sourcesUnder(dir: string): { readonly file: string; readonly text: string }[] {
  const root = `${kernelDir}${dir}`
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ file: `${dir}/${file}`, text: readFileSync(`${root}/${file}`, 'utf8') }))
}

/**
 * Each `process.env` read in a source's code, the read as written. The code is esbuild's parse of it
 * with every comment dropped: a comment may name `process.env`, and no `/*` in a comment or string
 * can hide the code after it. A string that names it still counts, which errs on the safe side.
 */
function processEnvReads(text: string): string[] {
  const code = transformSync(text, { loader: 'ts', legalComments: 'none' }).code
  const read =
    /\bprocess\s*(?:\??\.\s*env\b|(?:\?\.)?\[\s*(['"`])env\1\s*\])|\{[^{}]*\benv\b[^{}]*\}\s*=\s*(?:globalThis\.)?process\b/g
  return [...code.matchAll(read)].map(([match]) => match)
}

describe('kernel host independence', () => {
  it('bundles the pinned HTML converter without Node or DOM globals', async () => {
    expect(await bundleImportErrors('@mdream/js', 'htmlToMarkdown')).toEqual([])
  })

  it('imports neither contracts nor railguard, and opens no socket or resolver of its own (旧 236)', () => {
    const offenders = sourcesUnder('src').filter(({ text }) =>
      /from\s+['"](?:@tenon-app\/contracts|railguard|node:dns|node:net|dns|net)(?:\/[^'"]*)?['"]/.test(
        text,
      ),
    )
    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('names no provider in loop/, tools/ or permission/ (旧 236; A14)', () => {
    // The Ollama rule lives in the desktop's run-assembly.ts and reaches the loop as
    // `RunAssembly.toolsWithheld`; the loop never branches on a provider id.
    const offenders = ['src/loop', 'src/tools', 'src/permission']
      .flatMap((dir) => sourcesUnder(dir))
      .filter(({ text }) => /['"`]ollama['"`]/.test(text))
    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('reads no process.env anywhere in src (旧 142; §内置工具与参数「Bash」「起进程」)', () => {
    // Bash's shell and its environment come in through `LoopPorts.commandShell`.
    const offenders = sourcesUnder('src').flatMap(({ file, text }) =>
      processEnvReads(text).map((read) => `${file}: ${read}`),
    )
    expect(offenders).toEqual([])
  })

  it('finds a process.env read after a comment or string holding `/*`, and none in a comment', () => {
    const sample = [
      '// the carry rewrites `session/*` facts',
      'const home = process.env.HOME',
      'const note = `no message/* fact ${home}`',
      "const shell = process?.['env']",
      'const path = process?.env.PATH',
      '/** Reads no `process.env` of its own. */',
      'const { env: vars } = globalThis.process',
      'export const read = { note, shell, path, vars }',
    ].join('\n')
    expect(processEnvReads(sample)).toEqual([
      'process.env',
      'process?.["env"]',
      'process?.env',
      '{ env: vars } = globalThis.process',
    ])
  })

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
