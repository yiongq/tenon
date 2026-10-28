import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageRowContract } from '@tenon-app/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { PathText } from '@/components/ui/path-text'
import { readRecordMessages, recordRows } from '@/lib/snapshots'
import type { Round } from '@/lib/snapshots'
import { tx } from '@/lib/tx'
import { visible } from '@/lib/visible'
import { useSnapshotRounds } from '@/runtime/SnapshotProvider'

export function ThreadTitleMenu() {
  const { t } = useTranslation()
  const { sessionId, data, refresh } = useSnapshotRounds()
  const [open, setOpen] = useState(false)
  const [record, setRecord] = useState<{
    messages: readonly MessageRowContract[]
    round: Round | undefined
  } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    let current = true
    void Promise.all([readRecordMessages(window.tenon, sessionId), refresh()])
      .then(([messages, rounds]) => {
        if (!current) return
        if (rounds === null) setFailed(true)
        else setRecord({ messages, round: rounds.rounds.at(-1) })
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
    }
  }, [open, sessionId, refresh])
  const currentRound = data?.rounds.find((round) => round.roundRunId === record?.round?.roundRunId)
  const rows =
    record?.round === undefined
      ? []
      : recordRows(record.messages, currentRound ?? { ...record.round, canRestore: false })
  if (data === null && !open) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="app-no-drag"
              aria-label={t('snapshot.record.menu')}
              data-testid="thread-title-menu"
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto font-sans">
          <DropdownMenuItem
            onClick={() => {
              setRecord(null)
              setFailed(false)
              setOpen(true)
            }}
          >
            {t('snapshot.record.title')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[80vh] overflow-y-auto font-sans sm:max-w-3xl"
          closeLabel={t('snapshot.close')}
        >
          <DialogTitle className="font-sans">{t('snapshot.record.title')}</DialogTitle>
          {failed ? (
            <p role="alert">{t('snapshot.error.failed')}</p>
          ) : record === null ? (
            <output>{t('snapshot.loading')}</output>
          ) : rows.length === 0 ? (
            <p>{t('snapshot.record.empty')}</p>
          ) : (
            <ol className="space-y-4" data-testid="session-record">
              {rows.map((row) => (
                <li key={row.callKey} className="rounded-sm border border-border-default p-3">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui-sm">
                    <dt>{t('snapshot.record.tool')}</dt>
                    <dd>
                      <PathText text={visible(row.tool)} />
                    </dd>
                    <dt>{t('snapshot.record.object')}</dt>
                    <dd className="min-w-0 break-all">
                      <PathText text={visible(row.object)} />
                    </dd>
                    <dt>{t('snapshot.record.decision')}</dt>
                    <dd>
                      {row.decision === null ? (
                        t('snapshot.record.none')
                      ) : (
                        <>
                          {tx(t, `snapshot.verdict.${row.decision.verdict}`)}
                          {t('summary.separator')}
                          {tx(t, `snapshot.decision.${row.decision.code}`, row.decision.facts)}
                        </>
                      )}
                    </dd>
                    <dt>{t('snapshot.record.reversibility')}</dt>
                    <dd>
                      {row.reversibility === 'revertible'
                        ? t('snapshot.record.none')
                        : tx(t, `snapshot.reversibility.${row.reversibility}`)}
                    </dd>
                    <dt>{t('snapshot.record.snapshot')}</dt>
                    <dd className="min-w-0 break-all">
                      <PathText
                        text={
                          row.snapshotId === null
                            ? t('snapshot.record.none')
                            : visible(row.snapshotId)
                        }
                      />
                    </dd>
                    <dt>{t('snapshot.record.restorable')}</dt>
                    <dd>{t(row.canRestore ? 'snapshot.record.yes' : 'snapshot.record.no')}</dd>
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
