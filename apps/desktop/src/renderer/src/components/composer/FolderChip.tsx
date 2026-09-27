import {
  configGet,
  invokeRoute,
  workspacePick,
  workspaceRemove,
  workspaceUsePrefill,
} from '@tenon-app/contracts'
import { XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'

function folderName(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part !== '') ?? path
}

/**
 * The task profile's folders (spec 02 §界面范围 `FolderChip`; D11, D8): below the composer, only in
 * a task. The first one is where commands run; with none chosen, the session's own folder. Folders
 * come from main's dialog or the prefill it reads itself — this side only asks and removes.
 */
export function FolderChip(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const [prefill, setPrefill] = useState<readonly string[]>([])
  const workspace = snapshot.facts?.workspace ?? null
  // Read again every time the chip is shown, as the spec asks (「chip 每次展开都重读」).
  useEffect(() => {
    if (workspace === null) return
    let live = true
    void invokeRoute(window.tenon, configGet, {}).then((result) => {
      if (live && result.ok) setPrefill(result.data.lastWorkspaceFolders)
    })
    return () => {
      live = false
    }
  }, [workspace])
  if (snapshot.facts?.profile !== 'cowork' || workspace === null) return null
  const refresh = (): Promise<void> => store.refreshFacts()
  const picked = workspace.origin === 'picked'
  const unconfirmed = prefill.filter((folder) => !workspace.folders.includes(folder))
  return (
    <div
      data-testid="folder-chip"
      className="mt-2 flex flex-wrap items-center gap-1 font-sans text-micro"
    >
      <span className="text-text-muted">{t('folder.label')}</span>
      {workspace.folders.map((folder, index) => (
        <span
          key={folder}
          data-testid="folder-item"
          title={folder}
          className="flex items-center gap-1 rounded-pill border border-border-default px-2 py-0.5 text-text-secondary"
        >
          <span>{picked ? folderName(folder) : t('folder.dedicated')}</span>
          {index === 0 ? <span className="text-text-muted">{t('folder.cwd')}</span> : null}
          {picked ? (
            <button
              type="button"
              aria-label={t('folder.remove', { name: folderName(folder) })}
              data-testid="folder-remove"
              onClick={() =>
                void invokeRoute(window.tenon, workspaceRemove, {
                  sessionId: store.sessionId,
                  folder,
                }).then(refresh)
              }
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
      <button
        type="button"
        data-testid="folder-add"
        className="rounded-pill px-2 py-0.5 text-text-accent"
        onClick={() =>
          void invokeRoute(window.tenon, workspacePick, { sessionId: store.sessionId }).then(
            refresh,
          )
        }
      >
        {t('folder.add')}
      </button>
      {unconfirmed.length === 0 ? null : (
        <button
          type="button"
          data-testid="folder-prefill"
          title={unconfirmed.join('\n')}
          className="rounded-pill px-2 py-0.5 text-text-muted underline"
          onClick={() =>
            void invokeRoute(window.tenon, workspaceUsePrefill, {
              sessionId: store.sessionId,
            }).then(refresh)
          }
        >
          {t('folder.prefill', { count: unconfirmed.length })}
        </button>
      )}
    </div>
  )
}
