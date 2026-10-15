/** WCAG contrast of colours as the browser reports them computed (`rgb(r, g, b)` / `rgba(…)`). */

const linear = (v: number): number => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of an `rgb(r, g, b)` string. */
function luminanceOf(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
}

/** WCAG contrast ratio of two computed colours. */
export function contrastOf(a: string, b: string): number {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].toSorted((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}
