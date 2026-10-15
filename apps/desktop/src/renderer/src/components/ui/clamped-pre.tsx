import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { PathText } from '@/components/ui/path-text'
import { cn } from '@/lib/utils'

/**
 * Tool input, output and a card's change, as plain text that stops at one height.
 *
 * What does not fit is not cut off mid-line and left to a scroll bar nobody finds: the text fades
 * out at the bottom and a line below says how much more there is (「展开全部（N 行）」); a second
 * click puts it back. Text that fits shows neither the fade nor the line.
 *
 * N is the lines the text takes on screen, measured, not its newline count: one line of minified
 * JSON wraps to dozens, and a text that ends in a newline does not have an extra empty line.
 *
 * `paths`: the text is a command's or a tool's arguments, so a path in it breaks only after a `/`
 * (`PathText`), never inside a name like `my-project`. `'absolute'`: the text is output, where only
 * an absolute path is treated so (the note on a spilled result names its file) and the rest wraps
 * anywhere, as any output does.
 */
export function ClampedPre(props: {
  readonly text: string
  readonly className?: string
  readonly testId?: string
  readonly paths?: boolean | 'absolute'
}): JSX.Element {
  const { t } = useTranslation()
  const pre = useRef<HTMLPreElement | null>(null)
  const [clipped, setClipped] = useState(false)
  const [lines, setLines] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const measure = useCallback(() => {
    const el = pre.current
    // Only while collapsed: expanded, nothing overflows, and the way back must stay.
    if (el === null || expanded) return
    setClipped(el.scrollHeight > el.clientHeight + 1)
    const style = getComputedStyle(el)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    if (lineHeight > 0) setLines(Math.max(1, Math.round((el.scrollHeight - padding) / lineHeight)))
  }, [expanded])
  useLayoutEffect(measure, [measure, props.text])
  useEffect(() => {
    const el = pre.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    // A narrower column wraps the same text onto more lines.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])
  return (
    <div className="flex flex-col gap-1">
      <pre
        ref={pre}
        data-testid={props.testId}
        data-clipped={clipped && !expanded}
        className={cn(
          'whitespace-pre-wrap wrap-anywhere',
          expanded ? '' : 'max-h-60 overflow-hidden',
          clipped && !expanded ? 'edge-mask-end' : '',
          props.className,
        )}
      >
        {props.paths === undefined || props.paths === false ? (
          props.text
        ) : (
          <PathText text={props.text} absoluteOnly={props.paths === 'absolute'} />
        )}
      </pre>
      {clipped ? (
        <button
          type="button"
          data-testid="clamp-toggle"
          aria-expanded={expanded}
          className="self-start font-sans text-micro text-text-muted underline"
          onClick={() => setExpanded((was) => !was)}
        >
          {expanded ? t('clamp.collapse') : t('clamp.expandAll', { lines })}
        </button>
      ) : null}
    </div>
  )
}
