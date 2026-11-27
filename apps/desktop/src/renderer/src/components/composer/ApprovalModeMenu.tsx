import type { ApprovalMode } from '@tenon-app/contracts'
import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { modeMenuItems } from '@/lib/approval-mode'
import { cn } from '@/lib/utils'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import { useSnapshotRounds } from '@/runtime/SnapshotProvider'

/**
 * The approval mode (spec 06 §界面「档位菜单」): in a task only, the draft's included, in the tool
 * row's left cluster after the folders, opening upward. Two items, the current one ticked; a task
 * whose snapshots are unavailable can still pick auto, with the line saying changes are asked anyway
 * (D23). While the policy turns auto off there is only manual (D13, D40).
 *
 * The snapshot state is the one the settlement lines read (05 §快照怎么拍), refreshed as the menu
 * opens since it changes on its own.
 */
export function ApprovalModeMenu(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const { facts } = useSessionSnapshot()
  const { data: rounds, refresh } = useSnapshotRounds()
  const [open, setOpen] = useState(false)
  const items = modeMenuItems(facts)
  if (facts === null || items.length === 0) return null
  const mode = facts.approvalMode
  const noSnapshot = rounds?.status === 'unavailable'
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void refresh()
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-testid="approval-mode-trigger"
            data-mode={mode}
            aria-label={t('approvalMode.trigger', { mode: t(`approvalMode.${mode}.name`) })}
            className="h-auto min-h-(--t-h-control-compact) shrink-0 gap-1.5 px-2 py-0.5 font-sans text-ui-sm text-text-secondary"
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-pill',
            mode === 'auto' ? 'bg-fill-brand' : 'border border-text-muted',
          )}
        />
        <span className="whitespace-nowrap">{t(`approvalMode.${mode}.name`)}</span>
        <ChevronDownIcon aria-hidden className="size-4 text-text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-80 max-w-(--available-width)"
        data-testid="approval-mode-menu"
      >
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value: ApprovalMode) => {
            // Closed on a choice: the banner and the one-time notice it brings must be reachable.
            setOpen(false)
            if (value !== mode) void store.setApprovalMode(value)
          }}
        >
          {items.map((item) => (
            <DropdownMenuRadioItem
              key={item}
              value={item}
              closeOnClick
              data-testid={`approval-mode-${item}`}
              className="items-start py-2 pl-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-text-primary">
                  {t(`approvalMode.${item}.name`)}
                </span>
                <span className="whitespace-normal text-micro text-text-muted">
                  {t(`approvalMode.${item}.description`)}
                </span>
                {item === 'auto' && noSnapshot ? (
                  <span
                    data-testid="approval-mode-no-snapshot"
                    className="whitespace-normal text-micro text-text-warning"
                  >
                    {t('approvalMode.auto.noSnapshot')}
                  </span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
