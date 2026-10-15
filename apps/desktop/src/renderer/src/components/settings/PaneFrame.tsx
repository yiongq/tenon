import type { JSX, ReactNode } from 'react'

/**
 * The frame every panel shares: a header that stays put, one scroll area with a gutter reserved for
 * its bar (so content does not shift when the bar appears, and the bar never sits on a field's
 * edge), and an optional footer that stays put. The dialog has no other scroll area.
 */
export function PaneFrame(props: {
  readonly header: ReactNode
  readonly children: ReactNode
  readonly footer?: ReactNode
}): JSX.Element {
  return (
    <>
      <div className="px-4 pt-4 pr-12">{props.header}</div>
      <div
        data-testid="settings-scroll"
        // The padding is the fade's width (theme.css `edge-mask-y`), so at rest nothing is faded.
        className="edge-mask-y flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 [scrollbar-gutter:stable]"
      >
        {props.children}
      </div>
      {props.footer}
    </>
  )
}
