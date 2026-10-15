/**
 * The Tailwind theme layer (`src/styles/theme.css`) must produce CSS for every named step the
 * renderer — and the third-party components it ships — actually writes.
 *
 * REGRESSION. theme.css clears Tailwind's `--container-*` and `--text-*` namespaces so that only
 * Tenon's own steps exist, and it once put back just two container steps (xs, sm) and the Tenon
 * type steps. A utility whose step is missing does not fail anywhere: `max-w-3xl` compiles to
 * nothing. The settings and connector dialogs then spanned the whole window (~1250px), and every
 * Markdown heading Streamdown renders (`text-3xl` ... `text-lg`) fell back to the 16px body size.
 * Both bugs are invisible to a typecheck, a unit test of the components and a DOM-only e2e check,
 * so this test compiles the real stylesheet with Tailwind and asks it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'
import { describe, expect, it } from 'vitest'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stylesDir = join(desktop, 'src', 'styles')
const rendererSrc = join(desktop, 'src', 'renderer', 'src')

/** The CSS entry points `theme.css` imports by package name: Node cannot resolve their `style` exports. */
const PACKAGE_STYLES: Record<string, string> = {
  tailwindcss: 'tailwindcss/index.css',
  'tw-animate-css': 'tw-animate-css/dist/tw-animate.css',
  'shadcn/tailwind.css': 'shadcn/dist/tailwind.css',
}

async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : join(desktop, 'node_modules', PACKAGE_STYLES[id] ?? id)
  return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
}

async function compileTheme(candidates: readonly string[]): Promise<string> {
  const compiler = await compile(readFileSync(join(stylesDir, 'theme.css'), 'utf8'), {
    base: stylesDir,
    loadStylesheet,
  })
  return compiler.build([...candidates])
}

/** Custom properties of tokens.css's first block (`:root`, the theme-independent layers + light). */
function rootTokens(): Map<string, string> {
  const css = readFileSync(join(stylesDir, 'tokens.css'), 'utf8')
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

/** The value Tailwind generated for one utility's property, or undefined when it generated none. */
function declarationOf(css: string, utility: string, property: string): string | undefined {
  const escaped = utility.replace(/[:/]/g, (c) => '\\\\' + c)
  const rule = new RegExp(`\\.${escaped}(?![\\w-])\\s*(?:,[^{}]*)?\\{([^}]*)\\}`).exec(css)
  return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(rule?.[1] ?? '')?.[1]
}

/** A Tailwind step's declaration, resolved down to pixels through tokens.css. */
function pixels(css: string, utility: string, property: string): number {
  const tokens = rootTokens()
  const declaration = declarationOf(css, utility, property)
  if (declaration === undefined) throw new Error(`${utility} produced no ${property}`)
  const resolved = declaration.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const value = tokens.get(name)
    if (value === undefined) throw new Error(`${name} is not a token`)
    return value
  })
  const calc = /^calc\(\s*([\d.]+)px\s*\*\s*([\d.]+)\s*\)$/.exec(resolved)
  if (calc) return Number(calc[1]) * Number(calc[2])
  const px = /^([\d.]+)px$/.exec(resolved)
  if (px) return Number(px[1])
  throw new Error(`cannot resolve ${declaration} to pixels`)
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(tsx?|css)$/.test(name)) yield path
  }
}

/** Every class-ish word in the renderer's own sources plus the Markdown renderer's bundle. */
function sourceWords(): Set<string> {
  const files = [...walk(rendererSrc)]
  const streamdown = join(desktop, 'node_modules', 'streamdown', 'dist')
  files.push(...readdirSync(streamdown).map((n) => join(streamdown, n)))
  const words = new Set<string>()
  for (const file of files.filter((f) => /\.(tsx?|css|js)$/.test(f))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/[A-Za-z0-9:_\-/[\]().*%]+/g)) {
      words.add(m[0])
    }
  }
  return words
}

const NAMED_STEP = '(?:3xs|2xs|xs|sm|md|lg|xl|[2-9]xl)'

describe('theme.css container steps', () => {
  it('compiles every named max-w / w step the sources use', async () => {
    const used = [...sourceWords()].filter((w) =>
      new RegExp(`^(?:[a-z-]+:)*(?:max-w|min-w|w)-${NAMED_STEP}$`).test(w),
    )
    // Not vacuous: the dialogs, Streamdown and the tooltip all write named steps. (The settings
    // dialog sets its own 744px and no longer writes one.)
    expect(used).toEqual(expect.arrayContaining(['sm:max-w-xl', 'max-w-md']))
    const css = await compileTheme(used)
    for (const word of used) {
      const property = word.includes('max-w-')
        ? 'max-width'
        : word.includes('min-w-')
          ? 'min-width'
          : 'width'
      expect(declarationOf(css, word, property), `${word} compiled to nothing`).toBeDefined()
    }
  })

  it('keeps the dialogs bounded: xl 576px, 2xl 672px, 3xl 768px', async () => {
    const css = await compileTheme(['sm:max-w-xl', 'sm:max-w-2xl', 'sm:max-w-3xl', 'max-w-md'])
    expect(pixels(css, 'sm:max-w-xl', 'max-width')).toBe(576)
    expect(pixels(css, 'sm:max-w-2xl', 'max-width')).toBe(672)
    expect(pixels(css, 'sm:max-w-3xl', 'max-width')).toBe(768)
    expect(pixels(css, 'max-w-md', 'max-width')).toBe(448)
  })

  it('counts every step in 4px units, the way spacing does', () => {
    const theme = readFileSync(join(stylesDir, 'theme.css'), 'utf8')
    const steps = [
      ...theme.matchAll(/--container-([\w]+):\s*calc\(var\(--t-space-unit\) \* (\d+)\)/g),
    ]
    expect(steps.map((m) => m[1])).toEqual([
      '3xs',
      '2xs',
      'xs',
      'sm',
      'md',
      'lg',
      'xl',
      '2xl',
      '3xl',
      '4xl',
      '5xl',
      '6xl',
      '7xl',
    ])
    const widths = steps.map((m) => Number(m[2]))
    expect(widths).toEqual(widths.toSorted((a, b) => a - b))
  })
})

describe('theme.css type steps', () => {
  it('compiles every named text size the sources use', async () => {
    const used = [...sourceWords()].filter((w) =>
      new RegExp(`^(?:[a-z-]+:)*text-${NAMED_STEP}$`).test(w),
    )
    expect(used).toEqual(expect.arrayContaining(['text-3xl', 'text-2xl', 'text-xl', 'text-lg']))
    const css = await compileTheme(used)
    for (const word of used) {
      expect(declarationOf(css, word, 'font-size'), `${word} compiled to nothing`).toBeDefined()
    }
  })

  it('makes a Markdown heading larger than the body and each level larger than the next', async () => {
    // Streamdown: h1 = text-3xl, h2 = text-2xl, h3 = text-xl, h4 = text-lg.
    const css = await compileTheme(['text-3xl', 'text-2xl', 'text-xl', 'text-lg', 'text-base'])
    const [h1, h2, h3, h4, body] = ['text-3xl', 'text-2xl', 'text-xl', 'text-lg', 'text-base'].map(
      (name) => pixels(css, name, 'font-size'),
    )
    expect(h1).toBeGreaterThan(h2!)
    expect(h2).toBeGreaterThan(h3!)
    expect(h3).toBeGreaterThan(body!)
    // tokens.md: h4 shares the body size and is told apart by weight.
    expect(h4).toBe(body)
    expect(body).toBe(16)
  })
})

describe('theme.css craft utilities', () => {
  it('compiles the wrapping and fade classes the renderer relies on', async () => {
    const css = await compileTheme(['wrap-anywhere', 'edge-mask-y', 'edge-mask-end'])
    // The last resort for a path name longer than its line (components/ui/path-text.tsx).
    expect(declarationOf(css, 'wrap-anywhere', 'overflow-wrap')).toBe('anywhere')
    // Scrolling content fades at the edge of its scroll area; the mask reads an opaque surface
    // token, never a colour literal.
    for (const name of ['edge-mask-y', 'edge-mask-end']) {
      const mask = declarationOf(css, name, 'mask-image')
      expect(mask, `${name} compiled to nothing`).toBeDefined()
      expect(mask).toContain('var(--t-surface-0)')
      expect(mask).toContain('transparent')
    }
  })

  it('keeps the macOS title bar rules to data-platform="darwin" (N01)', async () => {
    const css = await compileTheme(['mac:pl-18', 'mac:ctl-h-lg', 'mac:pt-0'])
    // The variant applies under the darwin marker only: Windows and Linux compile no rule for it.
    expect(css).toMatch(/\.mac\\:pl-18:where\(\[data-platform=['"]?darwin['"]?\]/)
    expect(css).toContain('padding-left')
    const theme = readFileSync(join(stylesDir, 'theme.css'), 'utf8')
    // The drag handle is dropped everywhere else, and its controls opt out of it.
    expect(theme).toMatch(
      /:root\[data-platform='darwin'\] \.app-drag \{[^}]*-webkit-app-region: drag/,
    )
    expect(theme).toMatch(/\.app-drag :is\(button[^)]*\) \{[^}]*-webkit-app-region: no-drag/)
    // Dialogs, scrims and menus are portals after the band in the document: they opt out
    // themselves, or a click on one over the band drags the window (e2e/composer-frame.spec.ts
    // reads the region on macOS; this keeps the rule where a Linux CI sees it).
    expect(theme).toMatch(
      /:root\[data-platform='darwin'\] :is\(\[data-slot\$='-overlay'\], \[data-slot\$='-content'\]\) \{[^}]*-webkit-app-region: no-drag/,
    )
  })

  it('keeps the settings dialog at one fixed width and height', async () => {
    // The classes the dialog really carries, read from its source: a fixed height and a width,
    // each of which must compile (an arbitrary value Tailwind cannot parse compiles to nothing).
    const source = readFileSync(
      join(desktop, 'src', 'renderer', 'src', 'components', 'settings', 'SettingsModal.tsx'),
      'utf8',
    )
    const height = /(?<=[\s"])h-\[[^\]\s]+\]/.exec(source)?.[0]
    const width = /(?<=[\s"])sm:max-w-\[[^\]\s]+\]/.exec(source)?.[0]
    expect(height, 'SettingsModal.tsx sets no fixed h-[…]').toBeDefined()
    expect(width, 'SettingsModal.tsx sets no sm:max-w-[…]').toBeDefined()
    const css = await compileTheme([height!, width!])
    // 640px tall at most and 744px wide at most (e2e/ux-craft.spec.ts measures the real dialog).
    expect(css).toMatch(/height:\s*min\(640px,/)
    expect(css).toMatch(/max-width:\s*min\(744px,/)
  })
})
