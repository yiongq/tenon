/**
 * Where a path or a command may break across lines.
 *
 * A path or command that wraps mid-word (`real/m⏎y-project`) cannot be read back: the eye reads
 * "m" and "y-project" as two names. So the only soft break points are the spaces the text already
 * has and the position after each `/`; a name between two slashes stays in one piece, hyphens
 * included, and only a piece longer than the whole line may break anywhere (the component sets
 * `overflow-wrap: anywhere` for that last resort).
 */
export interface PathPiece {
  readonly text: string
  /**
   * `space`: whitespace, kept as it is (a newline in a command stays a newline).
   * `word`: text with no `/`, left to ordinary line breaking.
   * `segment`: one name of a path with its trailing `/`, which is never broken before the line
   * runs out of room.
   * `plain`: with `absoluteOnly`, a run of anything that is not an absolute path — spaces, words and
   * other slashes alike — left to the text's own line breaking.
   */
  readonly kind: 'space' | 'word' | 'segment' | 'plain'
  /** A break opportunity follows this piece even though no space does. */
  readonly breakAfter: boolean
}

/** `/x…` or `~/x…`: a path that names where it starts. A URL, `a/b` or `//` is not one. */
const ABSOLUTE = /^~?\/[^/]/

/**
 * Splits `text` into pieces whose concatenation is exactly `text`.
 *
 * `absoluteOnly`: for free text that may hold a path, as a tool's output does (the note on a spilled
 * result names the file it was saved to): only a whitespace-delimited token that is an absolute
 * path is split into names, and everything between two such paths is one `plain` piece, so a long
 * output stays a handful of nodes.
 */
export function pathPieces(
  text: string,
  options: { readonly absoluteOnly?: boolean } = {},
): readonly PathPiece[] {
  const pieces: PathPiece[] = []
  let plain = ''
  const flush = (): void => {
    if (plain !== '') pieces.push({ text: plain, kind: 'plain', breakAfter: false })
    plain = ''
  }
  for (const token of text.split(/(\s+)/)) {
    if (token === '') continue
    if (options.absoluteOnly === true && !ABSOLUTE.test(token)) {
      plain += token
      continue
    }
    flush()
    if (/^\s+$/.test(token)) {
      pieces.push({ text: token, kind: 'space', breakAfter: false })
    } else if (token.includes('/')) {
      const segments = token.split(/(?<=\/)/)
      segments.forEach((segment, index) => {
        pieces.push({ text: segment, kind: 'segment', breakAfter: index < segments.length - 1 })
      })
    } else {
      pieces.push({ text: token, kind: 'word', breakAfter: false })
    }
  }
  flush()
  return pieces
}
