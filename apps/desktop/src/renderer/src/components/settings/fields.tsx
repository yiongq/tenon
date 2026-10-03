import { ChevronDownIcon } from 'lucide-react'
import type { JSX, ReactNode, RefObject } from 'react'

/** A labelled field of the settings card: the label above, the control and its notes below. */
export function Field(props: { label: string; htmlFor: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={props.htmlFor}
        className="font-sans text-ui-sm font-medium text-text-secondary"
      >
        {props.label}
      </label>
      {props.children}
    </div>
  )
}

/**
 * One choice out of a list, as a NATIVE select.
 *
 * Not the menu the account row uses, and not one of the `ui/` popup primitives: every one of them
 * is portalled at `--t-z-popover`, which tokens.md puts BELOW `--t-z-modal` — inside this dialog
 * the list opens underneath the card and cannot be clicked (measured). A native select is drawn
 * by the platform above every layer, is keyboard-operable everywhere, and needs no new z token.
 * If a later phase wants the menu look here, it needs an "above the modal" layer in tokens.md
 * first, which is a design decision rather than a class on one component.
 */
export function Chooser(props: {
  id: string
  testId: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
  inputRef?: RefObject<HTMLSelectElement | null>
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="relative">
      <select
        id={props.id}
        data-testid={props.testId}
        {...(props.inputRef === undefined ? {} : { ref: props.inputRef })}
        value={props.value}
        disabled={props.disabled === true}
        onChange={(event) => props.onChange(event.target.value)}
        className="ctl-h w-full appearance-none rounded-lg border border-input bg-transparent pr-8 pl-2.5 font-sans text-ui text-text-primary transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-text-muted" />
    </div>
  )
}
