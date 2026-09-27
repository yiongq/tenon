/**
 * Text from a tool call as the card shows it (spec 02 §最小审批卡 ②′; E4, AGENTS.md「工具结果是不可信
 * 内容」): every control character (C0, C1: `\p{Cc}`), every format character (`\p{Cf}` — bidi
 * controls, zero-width characters, tag characters, the soft hyphen) and every other default-ignorable
 * code point (variation selectors, Hangul fillers), none of which a font draws, is written as a
 * visible `\u{XXXX}`; a newline as a visible mark before the line break. What the card shows is,
 * character for character, what will run.
 */
const HIDDEN = /(?!\n)[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

export const NEWLINE_MARK = '⏎'

export function visible(text: string): string {
  return text
    .replaceAll(
      HIDDEN,
      (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`,
    )
    .replaceAll('\n', `${NEWLINE_MARK}\n`)
}
