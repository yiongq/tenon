import type { TextMessagePartComponent } from '@assistant-ui/react'
import type { JSX } from 'react'
import { Streamdown } from 'streamdown'

/**
 * The one real entry in the block registry. This is NOT a markdown special case: `text` is
 * one registered block type whose renderer happens to render markdown.
 *
 * - `mode="streaming"` splits the text into blocks, so settled blocks memoize and only the
 *   tail re-renders. MEASURED: the code-block DOM node kept one identity across 93 frames
 *   of a character-by-character stream — no unmount/remount flicker.
 * - `parseIncompleteMarkdown` repairs half-written syntax so an unclosed fence or emphasis
 *   does not flash raw punctuation.
 * - `controls={false}` drops the copy/download chrome.
 *
 * TWO MEASURED GOTCHAS:
 * 1. Streamdown DROPS unknown props — a `data-testid` handed to <Streamdown> never reaches
 *    the DOM. Test hooks go on the wrapper below, not on the component.
 * 2. Streamdown merges your className with tailwind-merge, which treats an arbitrary text
 *    utility carrying no type hint as a COLOUR and silently drops it when it collides with
 *    the text-colour class next to it. The `length:` hint below is load-bearing; without it
 *    the font size vanishes from the rendered class list.
 */
export const StreamdownText: TextMessagePartComponent = ({ text, status }): JSX.Element => {
  return (
    <div data-testid="assistant-text" data-streaming={status.type === 'running'}>
      <Streamdown
        className="font-serif text-[length:var(--t-size-body)] leading-[var(--t-leading-body)] text-text-primary"
        mode="streaming"
        parseIncompleteMarkdown
        isAnimating={status.type === 'running'}
        controls={false}
      >
        {text}
      </Streamdown>
    </div>
  )
}
