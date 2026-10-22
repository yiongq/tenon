import type { JSX } from 'react'
import { useSessionSnapshot } from '@/runtime/ChatProvider'
import { FolderChip } from './FolderChip'
import { FolderToggle } from './FolderToggle'

/**
 * The left cluster of the composer's tool row — one slot, so what sits there can change without the
 * frame around it changing. The folder toggle and the task's chip share this row (presentation-r1).
 */
export function ComposerLead(): JSX.Element {
  const { facts } = useSessionSnapshot()
  return (
    <>
      <FolderToggle />
      {facts?.profile === 'cowork' ? <FolderChip autoOpenPrefill={!facts.established} /> : null}
    </>
  )
}
