// Acceptance 8 (kernel host-independence) as a regression test. The gate lives entirely in
// .oxlintrc.json, and oxlint's `overrides` REPLACE an earlier override's entry for a rule instead
// of merging into it — so one more override matching packages/kernel/src/**/*.ts that mentions
// `no-restricted-imports` switches the whole boundary off with nothing going red. This file pins
// the EFFECTIVE gate three ways: (a) by replaying the override chain over representative paths,
// (b) by running the repo's own oxlint binary over probe sources for the forms acceptance 8 names,
// and (c) by pinning the invocation itself — the root `lint` script's flags and the absence of a
// nested config — because a config is only as strong as the command line CI runs it with.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configText = readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8')
const oxlintBin = join(repoRoot, 'node_modules', '.bin', 'oxlint')

// .oxlintrc.json is JSONC. Strip comments with a scanner, not a regex: the ban messages are full
// of `//`-bearing prose and a regex would cut the file in half at the first one.
const stripJsonComments = (text) => {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
      continue
    }
    out += c
  }
  return out
}

const config = JSON.parse(stripJsonComments(configText))

// `pnpm lint` is the gate CI runs, and two of its flags are part of the boundary itself. Layer (b)
// below lints with the flags taken from here rather than a copy of them, so the probe cannot keep
// passing with options the real script has stopped using.
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const lintOxlintArgs = (() => {
  const script = packageJson.scripts?.lint ?? ''
  const command = script
    .split('&&')
    .map((part) => part.trim())
    .find((part) => part.startsWith('oxlint '))
  if (!command) {
    throw new Error(`lint-gate: the root "lint" script no longer runs oxlint: ${script}`)
  }
  return command.split(/\s+/).slice(1)
})()

const REQUIRED_LINT_FLAGS = [
  // Without it a nested .oxlintrc.json REPLACES the root config for its subtree.
  '--disable-nested-config',
  // Without it a rule downgraded to "warn" stops failing the build.
  '--max-warnings=0',
]

// Only the glob syntax the `files` keys actually use. Anything else throws instead of quietly
// matching nothing — a matcher that silently stopped matching would make every assertion vacuous.
const SUPPORTED_GLOB = /^[\w./*-]+$/
const globToRegExp = (glob) => {
  if (!SUPPORTED_GLOB.test(glob)) {
    throw new Error(`lint-gate: .oxlintrc.json uses glob syntax this test cannot match: ${glob}`)
  }
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] !== '*') {
      source += glob[i] === '.' ? '\\.' : glob[i]
      continue
    }
    if (glob[i + 1] === '*' && glob[i + 2] === '/') {
      source += '(?:[^/]+/)*'
      i += 2
      continue
    }
    if (glob[i + 1] === '*') {
      source += '.*'
      i += 1
      continue
    }
    source += '[^/]*'
  }
  return new RegExp(`^${source}$`)
}

// The rule oxlint plays by: base rules first, then every matching override in order, each one
// REPLACING whatever the rules it names were set to before.
const effectiveConfig = (path) => {
  const rules = { ...config.rules }
  let matched = 0
  for (const override of config.overrides) {
    if (!override.files.some((glob) => globToRegExp(glob).test(path))) continue
    matched += 1
    // Assign, not merge: each key the override names is overwritten whole.
    Object.assign(rules, override.rules)
  }
  return { rules, matched }
}

const KERNEL_PATHS = [
  'packages/kernel/src/x.ts',
  'packages/kernel/src/provider/wire/x.ts',
  'packages/kernel/src/testing/x.ts',
]
const GATED_PATHS = [...KERNEL_PATHS, 'packages/contracts/src/x.ts']

const BANNED_IMPORTS = [
  'electron',
  'keytar',
  '@napi-rs/keyring',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'undici',
  'node-fetch',
  'axios',
  'got',
  'ky',
  'ws',
  'better-sqlite3',
]
const BANNED_GLOBALS = [
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'process',
  'crypto',
  'setTimeout',
  'setInterval',
  'document',
  'window',
]
// no-restricted-globals only sees bare identifiers, so the globalThis.* forms are a separate rule
// carrying the same list plus the DOM storage globals; `globalThis.fetch ?? network.fetch` is the
// exact fallback the 01 spec forbids.
const BANNED_GLOBAL_PROPERTIES = [
  'globalThis.fetch',
  'globalThis.WebSocket',
  'globalThis.EventSource',
  'globalThis.XMLHttpRequest',
  'globalThis.process',
  'globalThis.crypto',
  'globalThis.setTimeout',
  'globalThis.setInterval',
  'globalThis.document',
  'globalThis.window',
  'globalThis.navigator',
  'globalThis.localStorage',
  'globalThis.sessionStorage',
]

// The `patterns` half of no-restricted-imports, which carries the inward-dependency rule
// (apps -> contracts -> kernel) that `paths` cannot express.
const BANNED_IMPORT_PATTERNS = [
  'electron/*',
  'keytar/*',
  '**/apps/**',
  '@tenon-app/desktop',
  '@tenon-app/server',
  '**/testing',
  '**/testing/*',
  '@tenon-app/kernel/testing',
]

const entriesOf = (value) => (Array.isArray(value) ? value.slice(1) : [])

const importGaps = (path, names) => {
  const entry = effectiveConfig(path).rules['no-restricted-imports']
  if (!Array.isArray(entry) || entry[0] !== 'error') {
    return [`${path}: no-restricted-imports is not set to "error"`]
  }
  const banned = new Set((entry[1]?.paths ?? []).map((one) => one.name))
  return names
    .filter((name) => !banned.has(name))
    .map((name) => `${path}: no-restricted-imports no longer bans "${name}"`)
}

const importPatternGaps = (path) => {
  const entry = effectiveConfig(path).rules['no-restricted-imports']
  if (!Array.isArray(entry) || entry[0] !== 'error') {
    return [`${path}: no-restricted-imports is not set to "error"`]
  }
  const banned = new Set((entry[1]?.patterns ?? []).flatMap((one) => one.group ?? []))
  return BANNED_IMPORT_PATTERNS.filter((group) => !banned.has(group)).map(
    (group) => `${path}: no-restricted-imports no longer bans the pattern "${group}"`,
  )
}

const globalGaps = (path) => {
  const entry = effectiveConfig(path).rules['no-restricted-globals']
  if (!Array.isArray(entry) || entry[0] !== 'error') {
    return [`${path}: no-restricted-globals is not set to "error"`]
  }
  const banned = new Set(entriesOf(entry).map((one) => one.name))
  return BANNED_GLOBALS.filter((name) => !banned.has(name)).map(
    (name) => `${path}: no-restricted-globals no longer bans "${name}"`,
  )
}

const propertyGaps = (path) => {
  const entry = effectiveConfig(path).rules['no-restricted-properties']
  if (!Array.isArray(entry) || entry[0] !== 'error') {
    return [`${path}: no-restricted-properties is not set to "error"`]
  }
  const banned = new Set(entriesOf(entry).map((one) => `${one.object}.${one.property}`))
  return BANNED_GLOBAL_PROPERTIES.filter((name) => !banned.has(name)).map(
    (name) => `${path}: no-restricted-properties no longer bans "${name}"`,
  )
}

const nodeModuleGaps = (path) => {
  const value = effectiveConfig(path).rules['import/no-nodejs-modules']
  return value === 'error' ? [] : [`${path}: import/no-nodejs-modules is ${value}, not "error"`]
}

describe('the effective .oxlintrc.json config', () => {
  it('reaches every gated path through at least two overrides', () => {
    // Vacuity guard for the glob matcher: if it stopped matching, every ban assertion below would
    // read an undefined rule and this test is the one that says so.
    expect(
      GATED_PATHS.filter((path) => effectiveConfig(path).matched < 2).map(
        (path) => `${path}: matched by fewer than two overrides`,
      ),
    ).toEqual([])
  })

  it('leaves paths outside kernel and contracts ungated', () => {
    // The other half of the vacuity guard: a matcher that matched everything would pass the bans.
    expect(effectiveConfig('apps/desktop/src/main/x.ts').rules['no-restricted-imports']).toBe(
      undefined,
    )
  })

  it('still bans every host dependency kernel and contracts may not import', () => {
    // Catches: an appended override for packages/kernel/src/**/*.ts whose no-restricted-imports
    // REPLACES the real list, and any single name dropped from the last kernel override.
    expect(GATED_PATHS.flatMap((path) => importGaps(path, BANNED_IMPORTS))).toEqual([])
  })

  it('still keeps contracts out of the kernel', () => {
    // Catches: narrowing the kernel override's `files` glob (e.g. so src/testing stops matching),
    // which silently hands those files the contracts-and-kernel list that omits this ban.
    expect(KERNEL_PATHS.flatMap((path) => importGaps(path, ['@tenon-app/contracts']))).toEqual([])
  })

  it('still points every dependency inward', () => {
    // Catches: dropping "@tenon-app/desktop" (or any other group member) from the `patterns` half
    // of no-restricted-imports, which the `paths` assertions above never read.
    expect(GATED_PATHS.flatMap((path) => importPatternGaps(path))).toEqual([])
  })

  it('still bans every host global', () => {
    // Catches: removing `fetch` (or any other name) from the no-restricted-globals list.
    expect(GATED_PATHS.flatMap((path) => globalGaps(path))).toEqual([])
  })

  it('still bans the globalThis.* form of every host global', () => {
    // Catches: removing the globalThis.fetch property ban, which no-restricted-globals cannot see.
    expect(GATED_PATHS.flatMap((path) => propertyGaps(path))).toEqual([])
  })

  it('still bans Node built-ins outright', () => {
    // Catches: turning import/no-nodejs-modules off for kernel/src in a later override.
    expect(GATED_PATHS.flatMap((path) => nodeModuleGaps(path))).toEqual([])
  })
})

// The override globs resolve against the CONFIG FILE's directory (verified: the same probe under
// a different root lints clean), so the gate is reproduced exactly by copying .oxlintrc.json
// verbatim next to a `packages/kernel/src/…` probe in a throwaway directory. oxlint has no stdin
// mode, and writing the probe into the real packages/kernel/src would leave a file that `tsc -b`,
// a vitest or tsc watch, or a parallel `pnpm lint` would trip over the moment this process died
// between write and unlink.
const lintProbe = (probePath, source, nestedConfigDir) => {
  const dir = mkdtempSync(join(tmpdir(), 'tenon-lint-gate-'))
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), configText)
    mkdirSync(dirname(join(dir, probePath)), { recursive: true })
    writeFileSync(join(dir, probePath), source)
    if (nestedConfigDir !== undefined) {
      mkdirSync(join(dir, nestedConfigDir), { recursive: true })
      writeFileSync(join(dir, nestedConfigDir, '.oxlintrc.json'), '{ "rules": {} }\n')
    }
    // The flags `pnpm lint` carries today, read from package.json rather than copied, plus the
    // config auto-discovery it relies on.
    const run = spawnSync(oxlintBin, [...lintOxlintArgs, probePath], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    })
    return { exitCode: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const KERNEL_PROBE = 'packages/kernel/src/probe.ts'
const PROBES = [
  {
    label: 'a bare fetch call',
    path: KERNEL_PROBE,
    source: `export const f = () => fetch('https://example.invalid')\n`,
    rule: 'no-restricted-globals',
  },
  {
    label: 'new WebSocket(…)',
    path: KERNEL_PROBE,
    source: `export const f = () => new WebSocket('wss://example.invalid')\n`,
    rule: 'no-restricted-globals',
  },
  {
    label: 'process.env',
    path: KERNEL_PROBE,
    source: `export const f = () => process.env['X']\n`,
    rule: 'no-restricted-globals',
  },
  {
    label: 'globalThis.fetch',
    path: KERNEL_PROBE,
    source: `export const f = () => globalThis.fetch('https://example.invalid')\n`,
    rule: 'no-restricted-properties',
  },
  {
    label: `import 'undici'`,
    path: KERNEL_PROBE,
    source: `import { fetch as f } from 'undici'\nexport const g = () => f\n`,
    rule: 'no-restricted-imports',
  },
  {
    label: `import 'better-sqlite3'`,
    path: KERNEL_PROBE,
    source: `import Database from 'better-sqlite3'\nexport const g = () => Database\n`,
    rule: 'no-restricted-imports',
  },
  {
    // The inward-dependency rule, which lives in `patterns` rather than `paths`.
    label: `import '@tenon-app/desktop'`,
    path: KERNEL_PROBE,
    source: `import type { X } from '@tenon-app/desktop'\nexport type Y = X\n`,
    rule: 'no-restricted-imports',
  },
  {
    label: `import 'node:https'`,
    path: KERNEL_PROBE,
    source: `import { request } from 'node:https'\nexport const g = () => request\n`,
    rule: 'import(no-nodejs-modules)',
  },
  {
    // src/testing is inside the gate too, and it is the subtree a narrowed `files` glob drops
    // first — acceptance 2's "ANY kernel file" includes the test fixtures.
    label: `import '@tenon-app/contracts' from src/testing`,
    path: 'packages/kernel/src/testing/probe.ts',
    source: `import type { X } from '@tenon-app/contracts'\nexport type Y = X\n`,
    rule: 'no-restricted-imports',
  },
]

describe('oxlint on a kernel/src probe', () => {
  it('reports nothing on host-independent source', () => {
    // Without this the whole layer would pass vacuously if the probe harness itself broke: a
    // config oxlint refused to read would make every probe below "fail lint" for the wrong reason.
    expect(lintProbe(KERNEL_PROBE, 'export const ok = (n: number) => n + 1\n')).toEqual({
      exitCode: 0,
      output: '',
    })
  })

  it.each(PROBES)('fails on $label and names the rule', ({ path, source, rule }) => {
    // Acceptance 8 asks for two things at once: lint fails, and it points at the rule by name.
    const { exitCode, output } = lintProbe(path, source)
    expect({ exitCode, named: output.includes(rule) }, `oxlint said:\n${output}`).toEqual({
      exitCode: 1,
      named: true,
    })
  })

  it('still fails when a nested .oxlintrc.json sits above the probe', () => {
    // Catches: dropping --disable-nested-config from the root `lint` script. A nested config
    // REPLACES the root one for its whole subtree, so without that flag an empty
    // packages/kernel/.oxlintrc.json switches the boundary off and this probe lints clean.
    const source = `export const f = () => fetch('https://example.invalid')\n`
    const { exitCode, output } = lintProbe(KERNEL_PROBE, source, 'packages/kernel')
    expect(
      { exitCode, named: output.includes('no-restricted-globals') },
      `oxlint said:\n${output}`,
    ).toEqual({ exitCode: 1, named: true })
  })
})

// The workspace trees oxlint lints. The pinned binary discovers a nested config named
// `.oxlintrc.json` or `.oxlintrc.jsonc` (a bare `.oxlintrc` or an `.oxlintrc.js` it ignores), so
// the walk below reports any file starting with `.oxlintrc` rather than guessing at that list.
const NESTED_CONFIG_ROOTS = ['apps', 'packages', 'examples', 'scripts']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.vite'])

const nestedOxlintConfigs = (dir, prefix) => {
  const found = []
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      found.push(...nestedOxlintConfigs(join(dir, entry.name), `${prefix}${entry.name}/`))
      continue
    }
    if (entry.name.startsWith('.oxlintrc')) found.push(`${prefix}${entry.name}`)
  }
  return found
}

describe('the lint invocation the gate depends on', () => {
  it('keeps the flags that make the root config binding', () => {
    // Catches: dropping --disable-nested-config or --max-warnings=0 from the root `lint` script,
    // either of which lets the gate be switched off without touching .oxlintrc.json at all.
    expect(
      REQUIRED_LINT_FLAGS.filter((flag) => !lintOxlintArgs.includes(flag)).map(
        (flag) => `package.json: the "lint" script no longer passes oxlint ${flag}`,
      ),
    ).toEqual([])
  })

  it('leaves no nested oxlint config in the linted trees', () => {
    // Catches: adding packages/kernel/.oxlintrc.json, which REPLACES the root config for the
    // kernel subtree. Agent worktrees under .claude are nested checkouts .gitignore already keeps
    // out of lint and format, so only the workspace trees are walked.
    expect(
      NESTED_CONFIG_ROOTS.filter((root) => existsSync(join(repoRoot, root)))
        .flatMap((root) => nestedOxlintConfigs(root, `${root}/`))
        .map(
          (path) =>
            `${path}: a nested oxlint config replaces the root .oxlintrc.json for its subtree`,
        ),
    ).toEqual([])
  })
})
