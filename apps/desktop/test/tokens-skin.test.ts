/**
 * `src/styles/tokens.css` is a transcription of `docs/ux/tokens.md`: three seeds, four derivation
 * rules, one value per key. The sheet says both files change in the same PR, "otherwise the table
 * is wrong at once" — this test is what notices. It recomputes every colour from the seeds in
 * tokens.md with the rules written there and compares the result with the CSS, then checks the
 * contrast promises the sheet makes (text on its own surface, text on solid fills, borders).
 *
 * The dark block exists twice in tokens.css (under `prefers-color-scheme` and under
 * `[data-theme='dark']`); a hand edit of one and not the other is invisible until someone's system
 * theme flips, so the two are compared key by key.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { windowBackground } from '../src/main/window-theme.js'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tokensCss = readFileSync(join(desktop, 'src', 'styles', 'tokens.css'), 'utf8')
const tokensMd = readFileSync(join(desktop, '..', '..', 'docs', 'ux', 'tokens.md'), 'utf8')

type Rgb = readonly [number, number, number]
type Tokens = ReadonlyMap<string, string>

function block(pattern: RegExp): Tokens {
  const body = pattern.exec(tokensCss)?.[1]
  if (body === undefined) throw new Error(`tokens.css has no block matching ${pattern}`)
  return new Map([...body.matchAll(/(--t-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

/** From the "亮色" marker to the next marker: the light values (the theme-independent layers are above it). */
const light = block(/亮色 =+ \*\/([\s\S]*?)\n\}/)
const darkMedia = block(
  /暗色：跟随系统 =+ \*\/\s*@media[^{]*\{\s*:root:not\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/,
)
const dark = block(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)

const rgb = (hex: string): Rgb => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`not a hex colour: ${hex}`)
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}
const hex = (c: Rgb): string => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

// tokens.md: interpolation runs on 0-255 integer channels, rounded half up.
const round = (x: number): number => Math.floor(x + 0.5)
const mix = (a: Rgb, b: Rgb, percent: number): Rgb =>
  [0, 1, 2].map((i) => round(a[i]! + (b[i]! - a[i]!) * (percent / 100))) as unknown as Rgb

function hsl(h: number, s: number, l: number): Rgb {
  const sat = s / 100
  const lig = l / 100
  const c = (1 - Math.abs(2 * lig - 1)) * sat
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lig - c / 2
  const sector = Math.floor(h / 60) % 6
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector]!
  return [round((r! + m) * 255), round((g! + m) * 255), round((b! + m) * 255)]
}

function saturationOf([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const lightness = (max + min) / 2
  return max === min ? 0 : ((max - min) / (1 - Math.abs(2 * lightness - 1))) * 100
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as unknown as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** Seeds from the table under 「种子与派生规则」. */
function seed(name: 'bg' | 'text' | 'accent'): Rgb {
  const row = new RegExp(`\\|\\s*\`${name}\`\\s*\\|\\s*\`(#[0-9a-fA-F]{6})\``).exec(tokensMd)?.[1]
  if (row === undefined) throw new Error(`tokens.md has no seed row for ${name}`)
  return rgb(row)
}
const [bg, text, accent] = [seed('bg'), seed('text'), seed('accent')]
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

const N = (p: number): Rgb => mix(bg, text, p)
const D = (p: number): Rgb => N(100 - p)
const L = (p: number): Rgb => mix(bg, WHITE, p)
const B = (p: number): Rgb => mix(text, BLACK, p)
const accentToText = (p: number): Rgb => mix(accent, text, p)
const accentToBg = (p: number): Rgb => mix(accent, bg, p)
// 规则 4: semantic colours share the accent's HSL saturation, only hue and lightness move.
const SAT = round(saturationOf(accent))
const semantic = (hue: number, lightness: number): Rgb => hsl(hue, SAT, lightness)

const LIGHT: Record<string, Rgb> = {
  'shell-bg': N(8),
  'shell-row-hover': N(16),
  'shell-row-selected': N(20),
  'surface-0': bg,
  'surface-1': L(40),
  'surface-2': N(4),
  'surface-3': N(12),
  'surface-panel': L(20),
  'surface-overlay': L(70),
  'surface-inverse': N(100),
  'text-primary': N(100),
  'text-secondary': N(84),
  'text-muted': N(68),
  'text-disabled': N(36),
  'text-accent': accentToText(24),
  'text-danger': semantic(358, 38),
  'text-success': semantic(148, 30),
  'text-warning': semantic(40, 30),
  'text-on-accent': WHITE,
  'text-on-danger': WHITE,
  'border-subtle': N(12),
  'border-default': N(20),
  'border-strong': N(52),
  'border-focus': accent,
  'fill-brand': accent,
  'fill-brand-quiet': mix(bg, accent, 16),
  'fill-accent': accentToText(12),
  'fill-accent-hover': accentToText(24),
  'fill-neutral': N(12),
  'fill-neutral-hover': N(16),
  'fill-danger': semantic(358, 44),
  'role-tooltip-fg': bg,
}

const DARK: Record<string, Rgb> = {
  'shell-bg': B(40),
  'shell-row-hover': D(0),
  'shell-row-selected': D(8),
  'surface-0': text,
  'surface-1': D(8),
  'surface-2': D(4),
  'surface-3': D(12),
  'surface-panel': B(20),
  'surface-overlay': D(16),
  'surface-inverse': D(100),
  'text-primary': D(100),
  'text-secondary': D(84),
  'text-muted': D(68),
  'text-disabled': D(36),
  'text-accent': accentToBg(54),
  'text-danger': semantic(358, 64),
  'text-success': semantic(148, 58),
  'text-warning': semantic(40, 58),
  'text-on-accent': text,
  'text-on-danger': WHITE,
  'border-subtle': D(12),
  'border-default': D(52),
  'border-strong': D(68),
  'border-focus': accentToBg(44),
  'fill-brand': accentToBg(24),
  'fill-brand-quiet': mix(text, accent, 40),
  'fill-accent': accentToBg(36),
  'fill-accent-hover': accentToBg(44),
  'fill-neutral': D(12),
  'fill-neutral-hover': D(16),
  'fill-danger': semantic(358, 44),
  'role-tooltip-fg': text,
}

const rgba = (c: Rgb, alpha: string): string => `rgb(${c.join(' ')} / ${alpha})`
const ALPHA_LIGHT: Record<string, string> = {
  'alpha-1': rgba(text, '0.04'),
  'alpha-2': rgba(text, '0.08'),
  'alpha-3': rgba(text, '0.16'),
  scrim: rgba(text, '0.48'),
}
const ALPHA_DARK: Record<string, string> = {
  'alpha-1': rgba(bg, '0.06'),
  'alpha-2': rgba(bg, '0.1'),
  'alpha-3': rgba(bg, '0.18'),
  scrim: 'rgb(0 0 0 / 0.6)',
}

const colorOf = (tokens: Tokens, key: string): Rgb => rgb(tokens.get(`--t-${key}`) ?? '')

describe('tokens.css against the seeds and rules in tokens.md', () => {
  it('writes every light colour as the rules derive it', () => {
    for (const [key, expected] of Object.entries(LIGHT)) {
      expect(light.get(`--t-${key}`), `light ${key}`).toBe(hex(expected))
    }
    for (const [key, expected] of Object.entries(ALPHA_LIGHT)) {
      expect(light.get(`--t-${key}`), `light ${key}`).toBe(expected)
    }
  })

  it('writes every dark colour as the rules derive it, in both dark blocks', () => {
    for (const tokens of [dark, darkMedia]) {
      for (const [key, expected] of Object.entries(DARK)) {
        expect(tokens.get(`--t-${key}`), `dark ${key}`).toBe(hex(expected))
      }
      for (const [key, expected] of Object.entries(ALPHA_DARK)) {
        expect(tokens.get(`--t-${key}`), `dark ${key}`).toBe(expected)
      }
    }
  })

  it('keeps the two dark blocks identical and the three blocks on the same keys', () => {
    expect(Object.fromEntries(darkMedia)).toEqual(Object.fromEntries(dark))
    expect([...darkMedia.keys()].toSorted()).toEqual([...light.keys()].toSorted())
  })

  it('lists every colour it ships in tokens.md', () => {
    const sheet = tokensMd.toLowerCase()
    const shipped = new Set<string>()
    for (const tokens of [light, dark]) {
      for (const value of tokens.values()) {
        if (value.startsWith('#')) shipped.add(value.toLowerCase())
        else if (value.startsWith('rgb(')) shipped.add(value)
      }
    }
    expect([...shipped].filter((value) => !sheet.includes(value))).toEqual([])
  })

  it('names the seeds the sheet claims', () => {
    expect([hex(bg), hex(text), hex(accent)]).toEqual(['#f4f5f3', '#15191a', '#1e5e4a'])
  })
})

describe('contrast promises', () => {
  for (const [name, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    const surface = colorOf(tokens, 'surface-0')

    it(`${name}: text reads at 4.5:1 on its own surface (disabled excepted)`, () => {
      for (const key of [
        'text-primary',
        'text-secondary',
        'text-muted',
        'text-accent',
        'text-danger',
        'text-success',
        'text-warning',
      ]) {
        expect(contrast(colorOf(tokens, key), surface), `${name} ${key}`).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    })

    it(`${name}: a link reads at 4.5:1 on every surface it lands on, dialogs and menus included`, () => {
      // Dark: the link one step brighter than the focus ring was 3.9:1 on surface-overlay (the
      // settings dialog's 「去取 key」).
      for (const under of ['surface-0', 'surface-1', 'surface-overlay']) {
        expect(
          contrast(colorOf(tokens, 'text-accent'), colorOf(tokens, under)),
          `${name} text-accent on ${under}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    })

    it(`${name}: text on a solid fill reads at 4.5:1`, () => {
      for (const [fg, fill] of [
        ['text-on-accent', 'fill-accent'],
        ['text-on-accent', 'fill-accent-hover'],
        ['text-on-danger', 'fill-danger'],
      ] as const) {
        expect(
          contrast(colorOf(tokens, fg), colorOf(tokens, fill)),
          `${name} ${fg} on ${fill}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    })

    it(`${name}: the focus ring and the brand mark are visible at 3:1`, () => {
      // The ring can land on anything, the Settings dialog's overlay included; the brand mark
      // (indicator bars, selection dots) only sits on the content surfaces.
      for (const [key, unders] of [
        ['border-focus', ['surface-0', 'surface-1', 'surface-overlay']],
        ['fill-brand', ['surface-0', 'surface-1']],
      ] as const) {
        for (const under of unders) {
          expect(
            contrast(colorOf(tokens, key), colorOf(tokens, under)),
            `${name} ${key} on ${under}`,
          ).toBeGreaterThanOrEqual(3)
        }
      }
    })
  }

  it('dark: input and card borders stand out from every dark surface at 3:1', () => {
    // The Settings dialog sits on surface-overlay, the lightest of the dark surfaces: an input
    // there was a faint outline when the border was only two ladder steps away from it.
    for (const key of ['border-default', 'border-strong']) {
      for (const under of ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-overlay']) {
        expect(
          contrast(colorOf(dark, key), colorOf(dark, under)),
          `dark ${key} on ${under}`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

describe('window background', () => {
  it('is the content surface of each theme, read from the sheet', () => {
    expect(windowBackground(false, tokensCss)).toBe(light.get('--t-surface-0'))
    expect(windowBackground(true, tokensCss)).toBe(dark.get('--t-surface-0'))
    expect(windowBackground(true, tokensCss)).toBe(darkMedia.get('--t-surface-0'))
  })

  it('is never the default white', () => {
    expect(windowBackground(false, tokensCss).toLowerCase()).not.toBe('#ffffff')
    expect(windowBackground(true, tokensCss).toLowerCase()).not.toBe('#ffffff')
  })
})
