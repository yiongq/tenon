import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { PathText } from '@/components/ui/path-text'
import { previewGroups, RestoreFlow } from '@/lib/snapshots'
import { tx } from '@/lib/tx'
import { visible } from '@/lib/visible'
import { useSnapshotRounds } from '@/runtime/SnapshotProvider'

export function RestoreLink({ roundRunId, label }: { roundRunId: string; label: string }) {
  const { t } = useTranslation()
  const { sessionId, refresh } = useSnapshotRounds()
  const flow = useMemo(
    () =>
      new RestoreFlow(window.tenon, sessionId, () => {
        void refresh()
      }),
    [sessionId, refresh],
  )
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot)
  const waiting = state.phase === 'loading' || state.phase === 'applying'
  return (
    <>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void flow.open(roundRunId)}
      >
        {label}
      </button>
      <Dialog
        open={state.phase !== 'closed'}
        onOpenChange={(open) => {
          if (!open) flow.cancel()
        }}
      >
        <DialogContent
          className="max-h-[80vh] overflow-y-auto font-sans sm:max-w-xl"
          closeLabel={t('snapshot.close')}
          showCloseButton={state.phase !== 'applying'}
        >
          <DialogTitle className="font-sans">{t('snapshot.title')}</DialogTitle>
          <DialogDescription>{t('snapshot.limits')}</DialogDescription>
          {waiting ? (
            <output>
              {t(state.phase === 'applying' ? 'snapshot.applying' : 'snapshot.loading')}
            </output>
          ) : null}
          {state.error === null ? null : (
            <p role="alert">{tx(t, `snapshot.error.${state.error}`)}</p>
          )}
          {state.preview === null ? null : (
            <>
              {previewGroups(state.preview).map((group) => (
                <section key={group.kind}>
                  <h3>{tx(t, `snapshot.count.${group.kind}`, { count: group.paths.length })}</h3>
                  <ul className="space-y-1">
                    {group.paths.map((item) => (
                      <li key={item.path} className="break-all">
                        <PathText text={visible(item.path)} />
                        {item.reason === null ? null : (
                          <>
                            {t('summary.separator')}
                            {tx(t, `snapshot.skip.${item.reason}`)}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {state.preview.conflicts.map((path) => (
                <fieldset
                  key={path}
                  disabled={waiting}
                  className="min-w-0 rounded-sm border border-border-default p-2"
                >
                  <legend className="break-all">
                    <PathText text={visible(path)} />
                  </legend>
                  <p>{t('snapshot.conflict')}</p>
                  {(['keep', 'overwrite'] as const).map((choice) => (
                    <label key={choice} className="mr-4 inline-flex items-center gap-1">
                      <input
                        type="radio"
                        name={path}
                        checked={state.selected.has(path) === (choice === 'overwrite')}
                        onChange={() => flow.select(path, choice === 'overwrite')}
                      />
                      {t(`snapshot.${choice}`)}
                    </label>
                  ))}
                </fieldset>
              ))}
            </>
          )}
          {state.done === null ? null : (
            <div aria-live="polite">
              <p>{t('snapshot.result', { ...state.done, failed: state.done.failed.length })}</p>
              <ul>
                {state.done.failed.map((path) => (
                  <li key={path}>
                    <PathText text={visible(path)} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={state.phase === 'applying'} onClick={flow.cancel}>
              {t(
                state.phase === 'done' || state.phase === 'error'
                  ? 'snapshot.close'
                  : 'snapshot.cancel',
              )}
            </Button>
            {state.preview === null ? null : (
              <Button disabled={waiting} onClick={() => void flow.confirm()}>
                {t('snapshot.confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
