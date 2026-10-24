import {
  configGet,
  invokeRoute,
  workspacePick,
  workspaceRemove,
  workspaceUsePrefill,
} from '@tenon-app/contracts'
import type { IpcResult, RouteResponse } from '@tenon-app/contracts'
import { XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'

function folderName(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part !== '') ?? path
}

/** Folders enter the workspace only through main's dialog or an explicit prefill confirmation. */
export function FolderChip({
  autoOpenPrefill = false,
}: {
  autoOpenPrefill?: boolean
}): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const [prefill, setPrefill] = useState<readonly string[]>([])
  const [open, setOpen] = useState(false)
  const [preserveFocus, setPreserveFocus] = useState(false)
  const [feedback, setFeedback] = useState<'root' | 'home' | null>(null)
  const offerOnMount = useRef(autoOpenPrefill)
  const workspace = snapshot.facts?.workspace ?? null
  // Re-read on every expansion and after workspace changes. Only the initial offer after turning
  // the toggle on opens automatically; closing the offer never confirms or immediately reopens it.
  useEffect(() => {
    if (workspace === null) return
    let live = true
    void invokeRoute(window.tenon, configGet, {}).then((result) => {
      if (!live || !result.ok) return
      setPrefill(result.data.lastWorkspaceFolders)
      if (offerOnMount.current) {
        offerOnMount.current = false
        if (
          result.data.lastWorkspaceFolders.some((folder) => !workspace.folders.includes(folder))
        ) {
          setPreserveFocus(true)
          setOpen(true)
        }
      }
    })
    return () => {
      live = false
    }
  }, [workspace, open])
  if (snapshot.facts?.profile !== 'cowork' || workspace === null) return null
  const refresh = (): Promise<void> => store.refreshFacts()
  const selected = async (
    result: IpcResult<RouteResponse<typeof workspacePick>>,
  ): Promise<void> => {
    if (!result.ok) return
    if (!result.data.ok) {
      if (result.data.code === 'root-folder') setFeedback('root')
      return
    }
    setFeedback(result.data.warning === 'home' ? 'home' : null)
    await refresh()
  }
  const picked = workspace.origin === 'picked'
  const unconfirmed = prefill.filter((folder) => !workspace.folders.includes(folder))
  const paths = workspace.folders.join('\n')
  const additional = `+${workspace.folders.length - 1}`
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setPreserveFocus(false)
          setOpen(next)
        }}
      >
        <PopoverTrigger
          data-testid="folder-chip"
          title={paths}
          aria-label={paths}
          className="flex min-h-5 min-w-0 items-center gap-1 rounded-pill border border-border-default px-2 font-sans text-micro text-text-secondary"
        >
          <span data-testid="folder-chip-name" className="min-w-0 wrap-anywhere whitespace-normal">
            {picked ? folderName(workspace.folders[0] ?? '') : t('folder.dedicated')}
          </span>
          {workspace.folders.length > 1 ? <span className="shrink-0">{additional}</span> : null}
        </PopoverTrigger>
        <PopoverContent
          data-testid="folder-popover"
          aria-label={t('folder.label')}
          align="start"
          side="top"
          initialFocus={preserveFocus ? false : undefined}
          className="w-[36rem] max-h-[min(24rem,var(--available-height))] max-w-[calc(100vw-2rem)] overflow-y-auto font-sans"
        >
          {workspace.folders.map((folder, index) => (
            <div
              key={folder}
              data-testid="folder-item"
              title={folder}
              className="flex min-w-0 items-start gap-2"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span data-testid="folder-path" className="wrap-anywhere">
                  {folder}
                </span>
                {index === 0 ? (
                  <span data-testid="folder-cwd" className="text-micro text-text-muted">
                    {t('folder.cwd')}
                  </span>
                ) : null}
              </div>
              {picked ? (
                <button
                  type="button"
                  aria-label={t('folder.remove', { name: folderName(folder) })}
                  data-testid="folder-remove"
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-alpha-1"
                  onClick={() =>
                    void invokeRoute(window.tenon, workspaceRemove, {
                      sessionId: store.sessionId,
                      folder,
                    }).then(refresh)
                  }
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              ) : null}
            </div>
          ))}
          {picked ? null : (
            <p data-testid="folder-dedicated-note" className="text-micro text-text-muted">
              {t('folder.dedicatedNote')}
            </p>
          )}
          <button
            type="button"
            data-testid="folder-add"
            className="min-h-6 self-start rounded-sm px-1 text-text-accent"
            onClick={() =>
              void invokeRoute(window.tenon, workspacePick, { sessionId: store.sessionId }).then(
                selected,
              )
            }
          >
            {t('folder.add')}
          </button>
          {unconfirmed.length === 0 ? null : (
            <div data-testid="folder-prefill-offer" className="flex min-w-0 flex-col gap-2">
              <p className="text-micro text-text-muted">{t('folder.prefillPending')}</p>
              {unconfirmed.map((folder) => (
                <p key={folder} data-testid="folder-prefill-path" className="wrap-anywhere">
                  {folder}
                </p>
              ))}
              <button
                type="button"
                data-testid="folder-prefill"
                className="min-h-6 self-start rounded-sm px-1 text-text-accent"
                onClick={() =>
                  void invokeRoute(window.tenon, workspaceUsePrefill, {
                    sessionId: store.sessionId,
                  }).then(selected)
                }
              >
                {t('folder.prefillUse', { count: unconfirmed.length })}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {feedback === null ? null : (
        <output data-testid="folder-feedback" className="font-sans text-micro text-text-secondary">
          {t(feedback === 'root' ? 'folder.rootRefused' : 'folder.homeWarning')}
        </output>
      )}
    </div>
  )
}
