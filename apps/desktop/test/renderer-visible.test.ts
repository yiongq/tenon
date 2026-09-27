/**
 * The approval card's escaping (spec 02 §最小审批卡 ②′; E4, AGENTS.md「工具结果是不可信内容」; plan step 20,
 * 旧 218): bidi controls, zero-width characters, every other C0 / C1 control, every other format
 * character (`\p{Cf}`: tag characters, the soft hyphen) and every other default-ignorable code point
 * (variation selectors among them) show as a visible `\u{XXXX}`, a newline as a visible mark before
 * the line break — so the string on the card maps back, character for character, to what will run.
 */
import { describe, expect, it } from 'vitest'
import { NEWLINE_MARK, visible } from '../src/renderer/src/lib/visible.js'

/** Code points in [from, to], inclusive. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/** §最小审批卡 ②′, list by list. */
const BIDI = [0x061c, 0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2066, 0x2069)]
const ZERO_WIDTH = [...range(0x200b, 0x200d), 0x2060, 0xfeff]
/** 「其余 C0 / C1 控制字符」: every Unicode control (Cc) — C0, DEL and C1 — but the newline. */
const CONTROLS = [...range(0x0000, 0x001f), 0x007f, ...range(0x0080, 0x009f)].filter(
  (cp) => cp !== 0x000a,
)
/**
 * 「其余格式字符」: the soft hyphen, the tag characters from U+E0000 on, and a sample of the rest of
 * `\p{Cf}` — Arabic number signs, the Mongolian vowel separator, invisible operators, the deprecated
 * format characters, interlinear annotation, shorthand format controls, musical symbol formatting.
 */
const FORMAT = [
  0x00ad,
  ...range(0x0600, 0x0605),
  0x06dd,
  0x070f,
  0x180e,
  ...range(0x2061, 0x2064),
  ...range(0x206a, 0x206f),
  ...range(0xfff9, 0xfffb),
  ...range(0x1bca0, 0x1bca3),
  ...range(0x1d173, 0x1d17a),
  0xe0001,
  ...range(0xe0020, 0xe007f),
]
/**
 * 「其余默认可忽略码位」 that are not format characters: variation selectors (U+FE00–U+FE0F,
 * U+E0100–U+E01EF), the combining grapheme joiner, the Hangul fillers, the Khmer inherent vowels,
 * the Mongolian free variation selectors.
 */
const IGNORABLE = [
  ...range(0xfe00, 0xfe0f),
  ...range(0xe0100, 0xe01ef),
  0x034f,
  0x115f,
  0x1160,
  0x3164,
  0xffa0,
  0x17b4,
  0x17b5,
  ...range(0x180b, 0x180d),
  0x180f,
]
const HIDDEN = [...BIDI, ...ZERO_WIDTH, ...CONTROLS, ...FORMAT, ...IGNORABLE]

const hex = (cp: number): string => cp.toString(16).toUpperCase().padStart(4, '0')

/**
 * The reader's side of the card: every `\u{XXXX}` back to its character, every mark-and-break back to
 * a newline. Test inputs hold neither a literal `\u{` nor a literal mark, so this is exact for them.
 */
function readBack(shown: string): string {
  return shown
    .replaceAll(`${NEWLINE_MARK}\n`, '\n')
    .replaceAll(/\\u\{([0-9A-F]{4,6})\}/g, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
}

describe('visible', () => {
  it('旧 218: shows a U+202E in a file name as a visible \\u{202E}, and maps back to the path', () => {
    // The classic spoof: the override flips `txt.exe` so the name reads as `invoice exe.txt`.
    const path = '/Users/me/Downloads/invoice‮txt.exe'
    const shown = visible(path)
    expect(shown).toBe('/Users/me/Downloads/invoice\\u{202E}txt.exe')
    expect(shown).not.toContain('‮')
    expect(readBack(shown)).toBe(path)
  })

  it.each(HIDDEN.map((cp) => [hex(cp), cp] as const))(
    'writes U+%s as a visible escape between its neighbours',
    (digits, cp) => {
      expect(visible(`a${String.fromCodePoint(cp)}b`)).toBe(`a\\u{${digits}}b`)
    },
  )

  it('writes an astral code point as one escape, not as its two surrogates', () => {
    // A tag letter: invisible, and able to smuggle ASCII text past a reader (U+E0041 is a tag 'A').
    expect(visible('rm\u{E0041}\u{E0042}')).toBe('rm\\u{E0041}\\u{E0042}')
    expect(visible('\u{E0100}')).toBe('\\u{E0100}')
  })

  it('shows the joiner and the selector inside an emoji: the card hides nothing, even there', () => {
    // ②′ names zero-width characters and variation selectors without exception.
    expect(visible('\u{1F469}‍\u{1F4BB}')).toBe('\u{1F469}\\u{200D}\u{1F4BB}')
    expect(visible('❤️')).toBe('❤\\u{FE0F}')
  })

  it('shows a newline as a visible mark before the line break, and a CR as an escape', () => {
    expect(visible('line one\nline two')).toBe(`line one${NEWLINE_MARK}\nline two`)
    // A CRLF is two characters, and both must be seen: the CR is a C0 control like any other.
    expect(visible('a\r\nb')).toBe(`a\\u{000D}${NEWLINE_MARK}\nb`)
    // Still a line break on screen: the command's shape is not flattened onto one line.
    expect(visible('x\ny').split('\n')).toHaveLength(2)
  })

  it('leaves printable text alone: ASCII, Latin-1, CJK, combining marks and astral characters', () => {
    const ascii = String.fromCodePoint(...range(0x20, 0x7e))
    // Latin-1's one hidden character, the soft hyphen, is left out here (it is in FORMAT).
    const latin1 = String.fromCodePoint(...range(0xa0, 0xff).filter((cp) => cp !== 0xad))
    const other = '工作区 · レポート · é · 😀 · 𝒳 · ⏏ · 　 · 한글'
    for (const text of [ascii, latin1, other]) expect(visible(text)).toBe(text)
  })

  it('maps a string of every hidden character back to itself, with nothing hidden left in it', () => {
    const input = `${HIDDEN.map((cp, i) => `${String(i)}${String.fromCodePoint(cp)}`).join('')}\nend`
    const shown = visible(input)
    expect(readBack(shown)).toBe(input)
    for (const cp of HIDDEN) expect(shown).not.toContain(String.fromCodePoint(cp))
    // The only newline left is the one that follows its mark.
    expect([...shown.matchAll(/\n/g)].map((m) => shown[(m.index ?? 0) - 1])).toEqual([NEWLINE_MARK])
  })
})
