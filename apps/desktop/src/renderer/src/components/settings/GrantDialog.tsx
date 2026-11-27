import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpDraft, RouteResponse, mcpPreview } from '@tenon-app/contracts'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PathText } from '@/components/ui/path-text'
import type { FolderGrantChoice } from '@/lib/folder-grant'
import {
  GRANT_BUTTONS,
  GRANT_DEFAULT,
  grantArgv,
  grantEnvironment,
  resolvedCopy,
  splitAtMarker,
  warningParts,
} from '@/lib/connector-consent'

/** Stands in for a warning's quoted value while its sentence is formatted (a private-use code point). */
const MARKER = '\u{E000}'
export function GrantDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: McpDraft
  preview: Extract<RouteResponse<typeof mcpPreview>, { ok: true }>
  busy?: boolean
  onChoose: (choice: 'cancel' | 'persistent' | 'run') => void
}) {
  const { t } = useTranslation(),
    cancel = useRef<HTMLButtonElement | null>(null),
    transport = props.draft.transport
  const environment = grantEnvironment(transport)
  const resolved = resolvedCopy(props.preview.resolved)
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy && !open) props.onChoose('cancel')
      }}
    >
      <DialogContent
        data-testid="connector-grant"
        showCloseButton={false}
        initialFocus={cancel}
        className="sm:max-w-xl max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t('mcp.grantTitle', { name: props.draft.displayName })}</DialogTitle>
          <DialogDescription>
            {t(transport.type === 'stdio' ? 'mcp.grantLocal' : 'mcp.grantRemote')}
          </DialogDescription>
        </DialogHeader>
        <div data-testid="grant-argv" className="flex min-w-0 flex-col gap-2">
          {grantArgv(
            transport.type === 'stdio'
              ? [transport.command, ...transport.args]
              : props.preview.argv,
          ).map((arg, i) => (
            <pre
              // oxlint-disable-next-line react/no-array-index-key -- argv order is fixed for this preview
              key={i}
              className="overflow-auto whitespace-pre-wrap font-mono text-ui-sm"
            >
              <PathText text={arg} />
            </pre>
          ))}
        </div>
        {transport.type === 'stdio' ? (
          <>
            <p>
              <PathText text={t(resolved.key, resolved.args)} />
            </p>
            {/* No variables, no list: an empty one is still a grid item and doubles the gap. */}
            {environment.plain.length + environment.keys.length > 0 ? (
              <ul data-testid="grant-environment">
                {environment.plain.map((line) => (
                  <li key={line} className="whitespace-pre-wrap">
                    <PathText text={line} />
                  </li>
                ))}
                {environment.keys.map((name) => (
                  <li key={name}>{t('mcp.keychainName', { name })}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <>
            <p className="wrap-anywhere">
              {t('mcp.origin', { origin: new URL(props.preview.argv[0]!).origin })}
            </p>
            {environment.keys.length > 0 ? (
              <ul data-testid="grant-environment">
                {environment.keys.map((name) => (
                  <li key={name}>{t('mcp.keychainName', { name })}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        {/* The sentence is interface copy and keeps to one line; what it quotes is content (a path,
            a package) and wraps only after a `/` (PathText). Separate spans, so each is held to its
            own rule (e2e/text-fit-03.spec.ts). */}
        <ul data-testid="grant-warnings" className="flex flex-col gap-1">
          {props.preview.warnings.map((warning, i) => {
            const parts = warningParts(warning)
            const copy = splitAtMarker(
              t(parts.key as never, parts.slot === null ? {} : { [parts.slot]: MARKER }),
              MARKER,
            )
            return (
              // oxlint-disable-next-line react/no-array-index-key -- warnings are fixed for this preview
              <li key={i} className="whitespace-pre-wrap">
                <span data-slot="warning-copy">{copy.before}</span>
                {parts.content === null ? null : (
                  <span data-slot="warning-content">
                    <PathText text={parts.content} />
                  </span>
                )}
                {copy.after === '' ? null : <span data-slot="warning-copy">{copy.after}</span>}
              </li>
            )
          })}
        </ul>
        <DialogFooter>
          {GRANT_BUTTONS.map((choice) => (
            <Button
              key={choice}
              ref={choice === GRANT_DEFAULT ? cancel : undefined}
              data-testid={`grant-${choice}`}
              variant={choice === 'run' ? 'default' : 'outline'}
              disabled={props.busy}
              onClick={() => props.onChoose(choice)}
            >
              {t(`mcp.grant.${choice}`)}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The folder version's answers, in the connector dialog's order (components.md `GrantDialog`). */
const FOLDER_BUTTONS: readonly FolderGrantChoice[] = ['cancel', 'always', 'session']

/**
 * 「允许访问这个文件夹」 (spec 06 §界面「文件夹授权」): for folders picked or prefilled that were never
 * 「以后都允许」. 「取消」 adds nothing; 「允许」 adds them to this task; 「以后都允许」 also keeps them, so
 * a later pick does not ask — no new task gets them by itself. The grant is access only: writes are
 * still asked in manual. Focus starts on 「取消」, like the connector's.
 */
export function FolderGrantDialog(props: {
  folders: readonly string[]
  busy?: boolean
  onChoose: (choice: FolderGrantChoice) => void
}) {
  const { t } = useTranslation()
  const cancel = useRef<HTMLButtonElement | null>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!props.busy && !open) props.onChoose('cancel')
      }}
    >
      <DialogContent
        data-testid="folder-grant"
        showCloseButton={false}
        initialFocus={cancel}
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {props.folders.length > 1
              ? t('folder.grant.titleMany', { count: props.folders.length })
              : t('folder.grant.title')}
          </DialogTitle>
          <DialogDescription>{t('folder.grant.description')}</DialogDescription>
        </DialogHeader>
        <ul data-testid="folder-grant-paths" className="flex min-w-0 flex-col gap-1">
          {props.folders.map((folder) => (
            <li key={folder} className="font-mono text-ui-sm">
              <PathText text={folder} />
            </li>
          ))}
        </ul>
        <p className="text-ui-sm text-text-muted">{t('folder.grant.alwaysNote')}</p>
        <DialogFooter>
          {FOLDER_BUTTONS.map((choice) => (
            <Button
              key={choice}
              ref={choice === 'cancel' ? cancel : undefined}
              data-testid={`folder-grant-${choice}`}
              variant={choice === 'session' ? 'default' : 'outline'}
              disabled={props.busy}
              onClick={() => props.onChoose(choice)}
            >
              {t(`folder.grant.${choice}`)}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
