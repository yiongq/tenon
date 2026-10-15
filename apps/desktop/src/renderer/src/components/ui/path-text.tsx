import { Fragment } from 'react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { pathPieces } from '@/lib/path-wrap'

/**
 * A path, a command or a sentence that holds one, wrapped only at `/` and at spaces (lib/path-wrap.ts).
 *
 * Each path name is an inline-block: an atomic box is never split by the line breaker, so a hyphen
 * inside `my-project` is not a break point, while the `<wbr>` after each `/` is. A name wider than
 * the line shrinks to the line (`max-w-full`) and breaks anywhere, which is the one case where
 * breaking mid-name is better than overflowing. The text content is the input, unchanged: copying,
 * searching and assistive technology see the same characters.
 */
export function PathText(props: {
  readonly text: string
  readonly className?: string
  /** Free text that may hold a path (tool output): only absolute paths are split into names. */
  readonly absoluteOnly?: boolean
}): JSX.Element {
  return (
    <span data-slot="path-text" className={cn('wrap-anywhere', props.className)}>
      {pathPieces(props.text, { absoluteOnly: props.absoluteOnly === true }).map((piece, index) =>
        piece.kind === 'segment' ? (
          // oxlint-disable-next-line react/no-array-index-key -- the pieces are a pure function of the text
          <Fragment key={index}>
            <span className="inline-block max-w-full wrap-anywhere">{piece.text}</span>
            {piece.breakAfter ? <wbr /> : null}
          </Fragment>
        ) : (
          piece.text
        ),
      )}
    </span>
  )
}
