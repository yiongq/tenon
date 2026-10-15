import type { TextMessagePartComponent } from '@assistant-ui/react'
import { useMemo } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Streamdown } from 'streamdown'
import type { ControlsConfig } from 'streamdown'

/**
 * Only the code block's copy button; everything else Streamdown can put on a block (a table's
 * copy and download, a diagram's, an image's) stays off. The block's single frame and its header
 * row are styled in styles/theme.css.
 */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
}

/**
 * The one real entry in the block registry. This is NOT a markdown special case: `text` is
 * one registered block type whose renderer happens to render markdown.
 *
 * - `mode="streaming"` splits the text into blocks, so settled blocks memoize and only the
 *   tail re-renders. MEASURED: the code-block DOM node kept one identity across 93 frames
 *   of a character-by-character stream — no unmount/remount flicker.
 * - `parseIncompleteMarkdown` repairs half-written syntax so an unclosed fence or emphasis
 *   does not flash raw punctuation.
 * - `controls` leaves one control on: the code block's copy button (header row, next to the
 *   language name). It copies through `navigator.clipboard`, the same write seam as the failure
 *   card's 「复制诊断信息」, which main allows to the app's own document only. Streamdown disables the
 *   button while the message is still streaming.
 * - Syntax colours are off on purpose: Streamdown 2.x highlights only through its separate code
 *   plugin, which brings in shiki and its grammars — a heavy dependency for a colour the block does
 *   not need to be readable.
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
  const { t } = useTranslation()
  // Every string Streamdown can show with the controls left on: the code block's copy button, and
  // the dialog its link safety (on by default) puts before an external link, plus an image that
  // failed to load. Anything else it carries belongs to a control switched off above.
  const translations = useMemo(
    () => ({
      copyCode: t('code.copy'),
      copied: t('code.copied'),
      openExternalLink: t('markdown.openExternalLink'),
      externalLinkWarning: t('markdown.externalLinkWarning'),
      openLink: t('markdown.openLink'),
      copyLink: t('markdown.copyLink'),
      close: t('markdown.close'),
      imageNotAvailable: t('markdown.imageNotAvailable'),
    }),
    [t],
  )
  return (
    <div data-testid="assistant-text" data-streaming={status.type === 'running'}>
      <Streamdown
        className="font-serif text-[length:var(--t-size-body)] leading-[var(--t-leading-body)] text-text-primary"
        mode="streaming"
        parseIncompleteMarkdown
        isAnimating={status.type === 'running'}
        controls={CONTROLS}
        lineNumbers={false}
        translations={translations}
      >
        {text}
      </Streamdown>
    </div>
  )
}
