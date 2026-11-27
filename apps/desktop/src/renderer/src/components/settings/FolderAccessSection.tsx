import { invokeRoute, workspaceAccess, workspaceRevokeAccess } from '@tenon-app/contracts'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { PathText } from '@/components/ui/path-text'

/**
 * 「权限与网络」's second block (spec 06 §界面「设置」「文件夹授权」): the folders 「以后都允许」 kept,
 * each revocable on its own. Revoking only brings the dialog back for later picks; a task already
 * using the folder keeps it.
 */
export function FolderAccessSection(): JSX.Element {
  const { t } = useTranslation()
  const [folders, setFolders] = useState<readonly string[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void invokeRoute(window.tenon, workspaceAccess, {}).then((result) => {
      if (live && result.ok) setFolders(result.data.folders)
    })
    return () => {
      live = false
    }
  }, [])
  const revoke = async (folder: string) => {
    setBusy(true)
    const result = await invokeRoute(window.tenon, workspaceRevokeAccess, { folder })
    if (result.ok) setFolders(result.data.folders)
    setBusy(false)
  }
  return (
    <section
      data-testid="folder-access"
      aria-labelledby="folder-access-title"
      className="flex flex-col gap-2 font-sans text-ui-sm"
    >
      <h3 id="folder-access-title" className="font-medium">
        {t('folder.access.title')}
      </h3>
      <p className="text-text-secondary">{t('folder.access.hint')}</p>
      {folders === null ? null : folders.length === 0 ? (
        <p data-testid="folder-access-empty" className="text-text-muted">
          {t('folder.access.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {folders.map((folder) => (
            <li key={folder} data-testid="folder-access-item" className="flex items-start gap-2">
              <p className="min-w-0 flex-1 font-mono">
                <PathText text={folder} />
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="folder-access-revoke"
                aria-label={t('folder.access.revokeLabel', { path: folder })}
                onClick={() => void revoke(folder)}
              >
                {t('folder.access.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
