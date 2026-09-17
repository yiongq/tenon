import { expect } from '@playwright/test'
import type { Locator } from '@playwright/test'

/** What one element matched by a Locator measured to, in CSS pixels. */
export interface TextFitMetrics {
  readonly label: string
  readonly text: string
  /** Line boxes the element's own text occupies. 1 = it did not wrap, 0 = nothing rendered. */
  readonly lineCount: number
  /** Fractional overflow of the text past its nearest clipping box, worst over the subtree. */
  readonly overflowX: number
  readonly overflowY: number
  /** `scrollWidth - clientWidth`, worst over the element and every non-scrollable descendant. */
  readonly scrollOverflowX: number
  readonly scrollOverflowY: number
  /** False when the element (or an ancestor) is not rendered at all. */
  readonly visible: boolean
}

/**
 * Measures every element a Locator matches, in one round trip.
 *
 * Three independent signals, because no single one catches all three ways a translated
 * label breaks (measured on a 264px sidebar with 28px rows, same shape in en and zh-CN):
 *
 * | failure                                 | lineCount | scrollOverflow | overflow |
 * |-----------------------------------------|-----------|----------------|----------|
 * | `nowrap` + `ellipsis`, label too long   | 1         | X 137 / 73     | X 137.44 |
 * | wraps inside a fixed-height row         | 2         | Y 3 / 6        | 0        |
 * | wraps in a row that is allowed to grow  | 2         | 0              | 0        |
 *
 * The third row is why the line count is load-bearing: nothing is clipped, so every
 * scroll* number stays clean and only the line count moves.
 *
 * Two measurement traps, both hit in practice:
 *  - line boxes must be counted on the elements that actually hold text. On a
 *    `display:flex` NavItem, `Range.selectNodeContents(button).getClientRects()` also
 *    returns the flex items' border boxes, which span both wrapped lines, so the wrapped
 *    row measures as 1 line. `element.getClientRects().length` is 1 for it too.
 *  - rects must be merged by vertical overlap. One visual line yields several rects
 *    (an icon, a `<strong>`, a clipped run): the clipped row reports 2 rects on 1 line.
 */
export async function measureTextFit(locator: Locator): Promise<TextFitMetrics[]> {
  return await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const el = element as HTMLElement
      const descendants = [...el.querySelectorAll('*')] as HTMLElement[]

      // Elements with a non-empty direct text node - the only ones with real line boxes.
      const textHosts = [el, ...descendants].filter((node) =>
        [...node.childNodes].some(
          (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '',
        ),
      )

      // Flat on purpose: this body is serialised into the page, so it cannot call helpers
      // defined outside the callback - and oxlint's unicorn/consistent-function-scoping
      // (repo category `suspicious`) rejects naming them inside it.
      let lineCount = 0
      let overflowX = 0
      let overflowY = 0
      for (const host of textHosts) {
        const range = document.createRange()
        range.selectNodeContents(host)
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
        rects.sort((a, b) => a.top - b.top)
        const lines: { top: number; bottom: number; left: number; right: number }[] = []
        for (const r of rects) {
          const last = lines.at(-1)
          const overlap =
            last === undefined ? 0 : Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top)
          if (last !== undefined && overlap > Math.min(r.height, last.bottom - last.top) / 2) {
            last.top = Math.min(last.top, r.top)
            last.bottom = Math.max(last.bottom, r.bottom)
            last.left = Math.min(last.left, r.left)
            last.right = Math.max(last.right, r.right)
          } else {
            lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
          }
        }
        lineCount = Math.max(lineCount, lines.length)

        // Nearest ancestor (self included) that CLIPS on each axis, as its padding box.
        // Per axis, because a sidebar list is typically `overflow-y:auto; overflow-x:hidden`:
        // a row below the fold is reachable by scrolling (not a truncation) while a long
        // label in that same list still gets eaten horizontally.
        // The box is derived from getBoundingClientRect minus fractional border widths, NOT
        // from clientWidth/clientHeight: those are integer-rounded, which costs up to 0.5px
        // an edge and reports ~0.4px of overflow on labels that are in fact perfectly fine.
        let clipX: { left: number; right: number } | null = null
        for (let cur: HTMLElement | null = host; cur !== null; cur = cur.parentElement) {
          const style = getComputedStyle(cur)
          if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue
          const box = cur.getBoundingClientRect()
          clipX = {
            left: box.left + Number.parseFloat(style.borderLeftWidth),
            right: box.right - Number.parseFloat(style.borderRightWidth),
          }
          break
        }
        let clipY: { top: number; bottom: number } | null = null
        for (let cur: HTMLElement | null = host; cur !== null; cur = cur.parentElement) {
          const style = getComputedStyle(cur)
          if (style.overflowY !== 'hidden' && style.overflowY !== 'clip') continue
          const box = cur.getBoundingClientRect()
          clipY = {
            top: box.top + Number.parseFloat(style.borderTopWidth),
            bottom: box.bottom - Number.parseFloat(style.borderBottomWidth),
          }
          break
        }
        for (const line of lines) {
          if (clipX !== null) {
            overflowX = Math.max(overflowX, line.right - clipX.right, clipX.left - line.left)
          }
          if (clipY !== null) {
            overflowY = Math.max(overflowY, line.bottom - clipY.bottom, clipY.top - line.top)
          }
        }
      }

      // In a flex row the button never overflows - the flex child shrinks - so walk the
      // subtree. Skip elements the user can scroll (`auto` / `scroll`): a thread pane that
      // scrolls is doing its job, only `hidden` / `clip` silently eats text.
      let scrollOverflowX = 0
      let scrollOverflowY = 0
      for (const node of [el, ...descendants]) {
        const style = getComputedStyle(node)
        if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') {
          scrollOverflowX = Math.max(scrollOverflowX, node.scrollWidth - node.clientWidth)
        }
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
          scrollOverflowY = Math.max(scrollOverflowY, node.scrollHeight - node.clientHeight)
        }
      }

      return {
        label:
          el.getAttribute('data-testid') ??
          el.getAttribute('aria-label') ??
          el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim(),
        lineCount,
        overflowX: Math.round(overflowX * 100) / 100,
        overflowY: Math.round(overflowY * 100) / 100,
        scrollOverflowX,
        scrollOverflowY,
        visible: el.getClientRects().length > 0,
      }
    }),
  )
}

/** Text ink sits a fraction of a pixel outside its box from hinting; only real clipping fails. */
const TOLERANCE_PX = 1

/** Every way one measured element fails 「不换行不截断」, as human-readable lines. */
export function textFitViolations(m: TextFitMetrics): string[] {
  const where = `${m.label} ${JSON.stringify(m.text)}`
  if (!m.visible) return [`${where} is not rendered (no client rects)`]
  const out: string[] = []
  if (m.lineCount !== 1) out.push(`${where} renders on ${String(m.lineCount)} lines, expected 1`)
  if (m.scrollOverflowX > 0)
    out.push(`${where} is clipped horizontally by ${String(m.scrollOverflowX)}px`)
  if (m.scrollOverflowY > 0)
    out.push(`${where} is clipped vertically by ${String(m.scrollOverflowY)}px`)
  if (m.overflowX > TOLERANCE_PX)
    out.push(`${where} overflows its clip box by ${String(m.overflowX)}px`)
  if (m.overflowY > TOLERANCE_PX)
    out.push(`${where} overflows its clip box by ${String(m.overflowY)}px`)
  return out
}

/**
 * Asserts every element the Locator matches renders its text on ONE line and clips nothing
 * (spec.md「国际化」: 界面文字在两种语言下都不换行不截断).
 *
 * `minimum` guards against a locator that silently matches nothing after a markup change.
 * One failure lists every offending label, not just the first, which is what you want when
 * a translation pass breaks six rows at once.
 */
export async function expectSingleLineUnclipped(locator: Locator, minimum = 1): Promise<void> {
  const metrics = await measureTextFit(locator)
  expect(
    metrics.length,
    `locator matched ${String(metrics.length)} elements`,
  ).toBeGreaterThanOrEqual(minimum)
  const violations = metrics.flatMap((m) => textFitViolations(m))
  expect(violations, violations.join('\n')).toEqual([])
}
