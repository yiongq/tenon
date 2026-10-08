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
import {
  GRANT_BUTTONS,
  GRANT_DEFAULT,
  grantArgv,
  grantEnvironment,
  resolvedCopy,
} from '@/lib/connector-consent'
import { visible } from '@/lib/visible'
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
              className="overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm"
            >
              {arg}
            </pre>
          ))}
        </div>
        {transport.type === 'stdio' ? (
          <>
            <p className="break-all">{t(resolved.key, resolved.args)}</p>
            <ul>
              {environment.plain.map((line) => (
                <li key={line} className="whitespace-pre-wrap break-all">
                  {line}
                </li>
              ))}
              {environment.keys.map((name) => (
                <li key={name}>{t('mcp.keychainName', { name })}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="break-all">
              {t('mcp.origin', { origin: new URL(props.preview.argv[0]!).origin })}
            </p>
            <ul>
              {environment.keys.map((name) => (
                <li key={name}>{t('mcp.keychainName', { name })}</li>
              ))}
            </ul>
          </>
        )}
        <ul data-testid="grant-warnings" className="flex flex-col gap-1">
          {props.preview.warnings.map((warning, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- warnings are fixed for this preview
            <li key={i} className="whitespace-pre-wrap break-all">
              {t(`mcp.warning.${warning.kind}` as never, {
                ...warning,
                ...('package' in warning ? { package: visible(warning.package) } : {}),
              })}
            </li>
          ))}
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
