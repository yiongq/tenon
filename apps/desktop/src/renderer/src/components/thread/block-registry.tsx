import type { MessagePrimitive } from '@assistant-ui/react'
import { PlainText } from './PlainText'
import { StreamdownText } from './StreamdownText'
import { UnknownBlock } from './UnknownBlock'

/**
 * spec.md「UI 最小集」: block 渲染器做成类型注册表（text 一种先），不做 markdown 特例分支.
 *
 * `MessagePrimitive.Parts`'s `components` prop IS that registry: one slot per part type,
 * dispatched on `part.type`. Phase 0 registers exactly one real renderer (`Text`) and points
 * every other slot — including the two `Fallback`s that catch unregistered tool and data
 * NAMES — at the same visible placeholder, so the registry is TOTAL: an unrecognised part is
 * shown, never silently dropped.
 *
 * assistant-ui has no single generic Fallback for an unknown part TYPE; the slot set is
 * fixed and typed (BaseComponents + StandardComponents in
 * @assistant-ui/core/dist/react/primitives/message/MessageParts.d.ts), so totality means
 * filling every slot. Adding a block type later is one line here, never a branch inside
 * StreamdownText.
 */
export const blockRegistry: NonNullable<MessagePrimitive.Parts.Props['components']> = {
  Text: StreamdownText,
  Empty: UnknownBlock.Empty,
  Reasoning: UnknownBlock.Of('reasoning'),
  Source: UnknownBlock.Of('source'),
  Image: UnknownBlock.Of('image'),
  File: UnknownBlock.Of('file'),
  Quote: UnknownBlock.Of('quote'),
  tools: { Fallback: UnknownBlock.Of('tool-call') },
  data: { Fallback: UnknownBlock.Of('data') },
}

/** Same registry for the user's side of the transcript; only the `text` renderer differs. */
export const userBlockRegistry: NonNullable<MessagePrimitive.Parts.Props['components']> = {
  ...blockRegistry,
  Text: PlainText,
}
