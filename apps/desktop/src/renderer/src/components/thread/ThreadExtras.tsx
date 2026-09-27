import { approvalList, invokeRoute } from '@tenon-app/contracts'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import { useNavigation } from '@/runtime/conversation'

/** The banner lists at most this many other sessions (暂定; calibrated in plan step 34). */
export const BANNER_LIMIT = 20

type Row = { readonly sessionId: string; readonly waitKind: 'approval' | 'question' | 'resume' }

const BANNER_KEY = {
  approval: 'banner.approval',
  question: 'banner.question',
  resume: 'banner.resume',
} as const satisfies Record<Row['waitKind'], string>

/**
 * The sessions other than this one that wait on you (spec 02 §离开会话 第 5 条; B18, H6): read once
 * each time the session on screen changes, this one left out — its card is answerable right here.
 * 「回去」 goes through the leave dialog and then switches by id.
 */
export function PendingApprovalBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const { switchTo } = useNavigation()
  const [rows, setRows] = useState<readonly Row[]>([])
  useEffect(() => {
    let live = true
    void invokeRoute(window.tenon, approvalList, { limit: BANNER_LIMIT }).then((result) => {
      if (live && result.ok) setRows(result.data.filter((row) => row.sessionId !== store.sessionId))
    })
    return () => {
      live = false
    }
  }, [store])
  if (rows.length === 0) return null
  return (
    <ul data-testid="pending-banner" className="mb-4 flex flex-col gap-1">
      {rows.map((row) => (
        <li
          key={row.sessionId}
          data-testid="pending-banner-row"
          data-wait-kind={row.waitKind}
          className="flex items-center justify-between gap-2 rounded-sm border border-border-default bg-surface-1 px-3 py-2 font-sans text-ui-sm text-text-secondary"
        >
          <span>{t(BANNER_KEY[row.waitKind])}</span>
          <Button
            variant="secondary"
            size="sm"
            data-testid="pending-banner-go"
            onClick={() => switchTo(row.sessionId)}
          >
            {t('banner.goBack')}
          </Button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Messages sent while a Run was busy (spec 02 §插话与输入框状态表; H13): user bubbles at the end of
 * the thread, from `chat.queue`, marked queued, each with withdraw, edit and send now.
 */
export function QueuedBubbles(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const [editing, setEditing] = useState<{ queuedId: string; text: string } | null>(null)
  if (snapshot.queue.length === 0) return null
  return (
    <ul data-testid="queued-bubbles" className="mb-6 flex flex-col items-end gap-2">
      {snapshot.queue.map((item) => (
        <li
          key={item.queuedId}
          data-testid="queued-bubble"
          data-queued-id={item.queuedId}
          className="flex max-w-[80%] flex-col items-end gap-1"
        >
          {editing?.queuedId === item.queuedId ? (
            <div className="flex w-full flex-col gap-1">
              <Textarea
                data-testid="queued-edit-input"
                value={editing.text}
                onChange={(event) =>
                  setEditing({ queuedId: item.queuedId, text: event.target.value })
                }
              />
              <div className="flex gap-1 self-end">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  {t('queue.cancel')}
                </Button>
                <Button
                  size="sm"
                  data-testid="queued-edit-save"
                  disabled={editing.text.trim() === ''}
                  onClick={() => {
                    void store.queueAct({
                      action: 'edit',
                      queuedId: item.queuedId,
                      text: editing.text.trim(),
                    })
                    setEditing(null)
                  }}
                >
                  {t('queue.save')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-md bg-role-user-bubble px-4 py-2 font-sans text-ui text-text-secondary">
              <p className="whitespace-pre-wrap">{item.text}</p>
            </div>
          )}
          <div className="flex items-center gap-2 font-sans text-micro text-text-muted">
            <span data-testid="queued-label">{t('queue.queued')}</span>
            <button
              type="button"
              data-testid="queued-withdraw"
              onClick={() => void store.queueAct({ action: 'withdraw', queuedId: item.queuedId })}
            >
              {t('queue.withdraw')}
            </button>
            <button
              type="button"
              data-testid="queued-edit"
              onClick={() => setEditing({ queuedId: item.queuedId, text: item.text })}
            >
              {t('queue.edit')}
            </button>
            <button
              type="button"
              data-testid="queued-send-now"
              onClick={() => void store.queueAct({ action: 'send-now', queuedId: item.queuedId })}
            >
              {t('queue.sendNow')}
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The session a window restored by itself is not "opened": when it can resume, the end of the thread
 * offers 「上次没做完 · 继续」, and only that click resumes it (§启动恢复与发送防护 第 4 步; 开放问题 26).
 */
export function ResumeRow(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  if (!snapshot.resumable || snapshot.running) return null
  return (
    <div
      data-testid="resume-row"
      className="mb-6 flex items-center justify-between gap-2 rounded-sm border border-border-default px-3 py-2 font-sans text-ui-sm text-text-secondary"
    >
      <span>{t('resume.row')}</span>
      <Button
        variant="secondary"
        size="sm"
        data-testid="resume-continue"
        onClick={() => void store.resume()}
      >
        {t('resume.continue')}
      </Button>
    </div>
  )
}
