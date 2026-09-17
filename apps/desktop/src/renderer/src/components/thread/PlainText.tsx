import type { TextMessagePartComponent } from '@assistant-ui/react'
import type { JSX } from 'react'

/** The user's own words: interface font, no markdown, line breaks preserved. */
export const PlainText: TextMessagePartComponent = ({ text }): JSX.Element => {
  return (
    <span data-testid="user-text" className="whitespace-pre-wrap break-words">
      {text}
    </span>
  )
}
