import type { MessagePrimitive } from '@assistant-ui/react'
import { PlainText } from './PlainText'
import { StreamdownText } from './StreamdownText'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolRow } from './ToolRow'
import { UnknownBlock } from './UnknownBlock'

/**
 * spec.md「UI 最小集」: block 渲染器做成类型注册表（text 一种先），不做 markdown 特例分支.
 *
 * `MessagePrimitive.Parts`'s `components` prop IS that registry: one slot per part type,
 * dispatched on `part.type`. Spec 02 registers text, thinking (`Reasoning`) and every tool call
 * (`tools.Fallback`, one `ToolRow` whatever the tool's name — its sentence is chosen by name inside)
 * and points every other slot at the same visible placeholder, so the registry is TOTAL: an
 * unrecognised part is shown, never silently dropped.
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
  Reasoning: ThinkingBlock,
  Source: UnknownBlock.Of('source'),
  Image: UnknownBlock.Of('image'),
  File: UnknownBlock.Of('file'),
  Quote: UnknownBlock.Of('quote'),
  tools: { Fallback: ToolRow },
  data: { Fallback: UnknownBlock.Of('data') },
}

/** Same registry for the user's side of the transcript; only the `text` renderer differs. */
export const userBlockRegistry: NonNullable<MessagePrimitive.Parts.Props['components']> = {
  ...blockRegistry,
  Text: PlainText,
}
