import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The visible placeholder a not-yet-registered block type renders as. The copy is a key
 * plus a fact (`type`), never a sentence assembled in the component — the repo's
 * react/jsx-no-literals gate rejects both bare JSX text and template literals as children.
 */
function Placeholder({ type }: { type: string }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="note"
      data-testid="unknown-block"
      data-block-type={type}
      className="rounded-sm border border-dashed border-border-default px-3 py-2 font-sans text-ui-sm text-text-muted"
    >
      {t('thread.unknownBlock', { kind: type })}
    </div>
  )
}

/**
 * Curries the placeholder for one registry slot. The returned component declares NO props,
 * which is what makes it assignable to every `*MessagePartComponent` slot: a
 * `ComponentType<Record<string, unknown>>` is NOT assignable under
 * `exactOptionalPropertyTypes` (its ComponentClass branch fails).
 */
function unknownBlockFor(type: string): () => JSX.Element {
  const Slot = (): JSX.Element => <Placeholder type={type} />
  Slot.displayName = `UnknownBlock(${type})`
  return Slot
}

/**
 * assistant-ui renders `Empty` whenever the LAST part of a message is not Text or Reasoning
 * (`unstable_showEmptyOnNonTextEnd` defaults to true), so the slot has to be filled — and filled
 * with nothing: it used to be a one-line-high box, which put 28px of air under every Run that ends
 * in a tool call and, with the message margin, a 90px hole between two calls of one task.
 */
function EmptyBlock(): null {
  return null
}

export const UnknownBlock = { Of: unknownBlockFor, Empty: EmptyBlock }
