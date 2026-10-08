import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  invokeRoute,
  mcpDelete,
  mcpSave,
  mcpPreview,
  mcpConnect,
  mcpSetToolSetting,
  mcpRelease,
  mcpReviewChange,
  mcpSetInstructions,
  mcpRestart,
  mcpRefreshTools,
  mcpLogin,
  mcpCancelLogin,
  mcpRevoke,
  mcpReadLog,
} from '@tenon-app/contracts'
import type { McpServerView, RouteResponse } from '@tenon-app/contracts'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { DestructiveConfirm } from '@/components/ui/DestructiveConfirm'
import {
  TOOL_SETTING_KEY,
  toolSettings,
  draftOf,
  unavailableKey,
  MCP_EFFECTIVE_NEXT,
  MCP_NEVER_NOTE,
  connectorStatus,
} from '@/lib/connectors'
import { mcpAction } from '@/runtime/mcp-store'
import { Chooser } from './fields'
import { ConnectorForm } from './ConnectorForm'
import { GrantDialog } from './GrantDialog'
export function ConnectorDetail({ server: s }: { server: McpServerView }) {
  const { t } = useTranslation(),
    [editing, setEditing] = useState(false),
    [removing, setRemoving] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [log, setLog] = useState<string | null>(null),
    [review, setReview] = useState<RouteResponse<typeof mcpReviewChange> | null>(null),
    [grant, setGrant] = useState<Extract<RouteResponse<typeof mcpPreview>, { ok: true }> | null>(
      null,
    )
  const write = async (p: Parameters<typeof mcpAction>[0]) => {
    setError(await mcpAction(p))
  }
  const login = async () => {
    setBusy(true)
    await write(invokeRoute(window.tenon, mcpLogin, { id: s.id }))
    setBusy(false)
  }
  const connect = async () => {
    const r = await invokeRoute(window.tenon, mcpPreview, { draft: draftOf(s) })
    if (r.ok && r.data.ok) setGrant(r.data)
    else setError('unavailable')
  }
  const view = async (target: { tool: string } | { instructions: true }) => {
    const r = await invokeRoute(window.tenon, mcpReviewChange, { id: s.id, target })
    if (r.ok) setReview(r.data)
    else setError('unavailable')
  }
  return (
    <div data-testid="connector-detail" className="flex min-w-0 flex-col gap-3">
      <h3 className="break-all font-medium">
        {t('mcp.nameId', { name: s.displayName, id: s.id })}
      </h3>
      <p>
        {t(`mcp.status.${connectorStatus(s)}` as never, {
          version: s.status.protocolVersion ?? '',
          n: s.toolViews.length,
          seconds: Math.ceil((s.status.restartInMs ?? 0) / 1000),
        })}
      </p>
      <p>
        {t('mcp.protocolValue', {
          era: s.status.era ?? '—',
          version: s.status.protocolVersion ?? '—',
        })}
      </p>
      {s.status.error ? (
        <>
          <p>{t(`mcp.error.${s.status.error.code}` as never)}</p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">
            {s.status.error.stderrTail}
          </pre>
        </>
      ) : null}
      {s.transport.type === 'http' && s.status.error?.code === 'era-negotiation-failed' ? (
        <Button
          onClick={() => {
            const draft = draftOf(s)
            if (draft.transport.type === 'http') {
              draft.transport.protocol = 'legacy'
              void write(
                invokeRoute(window.tenon, mcpSave, {
                  mode: 'update',
                  draft,
                  secrets: { env: {}, headers: {} },
                  consent: null,
                }),
              )
            }
          }}
        >
          {t('mcp.changeLegacy')}
        </Button>
      ) : null}
      {s.needsConsent ? (
        <Button onClick={() => void connect()} data-testid="connector-connect">
          {t('mcp.confirmConnect')}
        </Button>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-3">
        {s.toolViews.map((tool) => (
          <li
            key={tool.originalName}
            data-testid={`connector-tool-${tool.originalName}`}
            className="flex min-w-0 flex-col gap-1 rounded-md border border-border-default p-2"
          >
            <span className="break-all font-medium">{tool.originalName}</span>
            <p className="whitespace-pre-wrap break-all text-ui-sm">{tool.description}</p>
            <Chooser
              id={`${s.id}-${tool.originalName}`}
              testId={`tool-setting-${tool.originalName}`}
              value={tool.setting}
              disabled={tool.review === 'new'}
              options={toolSettings(tool).map((value) => ({
                value,
                label: t(TOOL_SETTING_KEY[value]),
              }))}
              onChange={(setting) =>
                void write(
                  invokeRoute(window.tenon, mcpSetToolSetting, {
                    id: s.id,
                    tool: tool.originalName,
                    setting: setting as 'ask' | 'always-allow' | 'never',
                  }),
                )
              }
            />
            <span className="text-micro text-text-muted">{t(MCP_EFFECTIVE_NEXT)}</span>
            {tool.setting === 'never' ? <p className="text-micro">{t(MCP_NEVER_NOTE)}</p> : null}
            {tool.unavailable ? <p>{t(unavailableKey(tool.unavailable))}</p> : null}
            {tool.review !== 'ok' ? (
              <>
                <p>{t(tool.review === 'new' ? 'mcp.newTool' : 'mcp.definitionChanged')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void view({ tool: tool.originalName })}
                  >
                    {t('mcp.viewChange')}
                  </Button>
                  <Button
                    size="sm"
                    data-testid={`tool-release-${tool.originalName}`}
                    onClick={() =>
                      void write(
                        invokeRoute(window.tenon, mcpRelease, {
                          id: s.id,
                          target: { tool: tool.originalName },
                          definitionHash: tool.definitionHash,
                        }),
                      )
                    }
                  >
                    {t('mcp.release')}
                  </Button>
                  <span className="text-micro">{t(MCP_EFFECTIVE_NEXT)}</span>
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {s.instructionsView ? (
        <>
          <label className="flex gap-2 items-center">
            <Switch
              checked={s.instructions.enabled}
              onCheckedChange={(enabled) =>
                void write(invokeRoute(window.tenon, mcpSetInstructions, { id: s.id, enabled }))
              }
            />
            {t('mcp.instructions')}
          </label>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {s.instructionsView.text}
          </pre>
          {s.instructionsView.review === 'changed' ? (
            <div className="flex flex-wrap gap-2">
              <span>{t('mcp.definitionChanged')}</span>
              <Button variant="outline" onClick={() => void view({ instructions: true })}>
                {t('mcp.viewChange')}
              </Button>
              <Button
                onClick={() =>
                  void write(
                    invokeRoute(window.tenon, mcpRelease, {
                      id: s.id,
                      target: { instructions: true },
                      definitionHash: s.instructionsView!.hash,
                    }),
                  )
                }
              >
                {t('mcp.release')}
              </Button>
              <span>{t(MCP_EFFECTIVE_NEXT)}</span>
            </div>
          ) : null}
        </>
      ) : null}
      <p>
        {t('mcp.timeouts', {
          handshake: s.handshakeTimeoutSec ?? 30,
          call: s.callTimeoutSec ?? 60,
        })}
      </p>
      {s.transport.type === 'http' ? (
        <p>
          {t('mcp.protocolSelected', {
            protocol: t(s.transport.protocol === 'auto' ? 'mcp.auto' : 'mcp.legacy'),
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void invokeRoute(window.tenon, mcpReadLog, { id: s.id }).then((r) => {
              if (r.ok) setLog(r.data.text)
              else setError('unavailable')
            })
          }
        >
          {t('mcp.log')}
        </Button>
        <Button
          variant="outline"
          onClick={() => void write(invokeRoute(window.tenon, mcpRestart, { id: s.id }))}
        >
          {t('mcp.restart')}
        </Button>
        <Button
          variant="outline"
          onClick={() => void write(invokeRoute(window.tenon, mcpRefreshTools, { id: s.id }))}
        >
          {t('mcp.refresh')}
        </Button>
        {s.transport.type === 'http' ? (
          <Button disabled={busy} data-testid="connector-login" onClick={() => void login()}>
            {t(s.loggedIn ? 'mcp.relogin' : 'mcp.login')}
          </Button>
        ) : null}
        {busy ? (
          <Button
            variant="outline"
            onClick={() => void write(invokeRoute(window.tenon, mcpCancelLogin, { id: s.id }))}
          >
            {t('mcp.cancelLogin')}
          </Button>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void write(invokeRoute(window.tenon, mcpRevoke, { id: s.id }))}
        >
          {t('mcp.revoke')}
        </Button>
        <Button variant="outline" data-testid="connector-edit" onClick={() => setEditing(true)}>
          {t('mcp.edit')}
        </Button>
        <Button variant="outline" onClick={() => setRemoving(true)}>
          {t('mcp.delete')}
        </Button>
      </div>
      {error ? <p role="alert">{t(`mcp.error.${error}` as never)}</p> : null}
      {editing ? <ConnectorForm open onOpenChange={setEditing} server={s} /> : null}
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        name={s.displayName}
        busy={busy}
        onConfirm={() => {
          setBusy(true)
          void write(invokeRoute(window.tenon, mcpDelete, { id: s.id })).finally(() => {
            setBusy(false)
            setRemoving(false)
          })
        }}
      />
      {grant ? (
        <GrantDialog
          open
          onOpenChange={() => setGrant(null)}
          draft={draftOf(s)}
          preview={grant}
          onChoose={(choice) => {
            setGrant(null)
            if (choice !== 'cancel')
              void write(invokeRoute(window.tenon, mcpConnect, { id: s.id, consent: choice }))
          }}
        />
      ) : null}
      <Dialog
        open={log !== null || review !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLog(null)
            setReview(null)
          }
        }}
      >
        <DialogContent
          data-testid="connector-review-dialog"
          closeLabel={t('mcp.cancel')}
          className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{t(log !== null ? 'mcp.log' : 'mcp.viewChange')}</DialogTitle>
            <DialogDescription>{t('mcp.reviewNote')}</DialogDescription>
          </DialogHeader>
          {review ? (
            <>
              <h4>{t('mcp.before')}</h4>
              <pre className="overflow-auto whitespace-pre-wrap break-all">
                {review.before ?? t('mcp.noBefore')}
              </pre>
              <h4>{t('mcp.after')}</h4>
              <pre className="overflow-auto whitespace-pre-wrap break-all">{review.after}</pre>
            </>
          ) : (
            <pre className="overflow-auto whitespace-pre-wrap break-all">{log}</pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
