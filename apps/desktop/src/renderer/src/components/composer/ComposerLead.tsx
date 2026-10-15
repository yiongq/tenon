import type { JSX } from 'react'
import { ModeSwitch } from './ModeSwitch'

/**
 * The left cluster of the composer's tool row — one slot, so what sits there can change without the
 * frame around it changing. Today it holds 「对话 / 任务」 (`ModeSwitch`, spec 02 §界面范围); the task's
 * folders are not here but under the box, where 02 puts `FolderChip`. A later presentation spec
 * may replace both with a single 「在文件夹里工作」 toggle; that swap is this file's and the Composer's.
 */
export function ComposerLead(): JSX.Element {
  return <ModeSwitch />
}
