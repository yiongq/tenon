import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invokeRoute, providerList, mcpReorder, mcpSetEnabled } from '@tenon-app/contracts'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { reorderConnector, connectorStatus, MCP_EFFECTIVE_NEXT } from '@/lib/connectors'
import { useMcp, mcpAction } from '@/runtime/mcp-store'
import { ConnectorDetail } from './ConnectorDetail'
import { ConnectorForm } from './ConnectorForm'
export function ConnectorsPane() {
  const { t } = useTranslation(),
    { servers, overLimit } = useMcp()
  const [selected, setSelected] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [drag, setDrag] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<Record<string, string>>({})
  useEffect(() => {
    void invokeRoute(window.tenon, providerList, {}).then((r) => {
      if (r.ok)
        setProviders(
          Object.fromEntries(r.data.map((p) => [p.id, p.displayName ?? t(p.nameKey as never)])),
        )
    })
  }, [t])
  const server = servers.find((s) => s.id === selected)
  const reorder = async (id: string) => {
    if (!drag || drag === id) return
    const ids = reorderConnector(
      servers.map((s) => s.id),
      drag,
      id,
    )
    setError(await mcpAction(invokeRoute(window.tenon, mcpReorder, { ids })))
    setDrag(null)
  }
  return (
    <div data-testid="connectors-pane" className="flex min-w-0 flex-col gap-3">
      {server ? (
        <>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            {t('mcp.back')}
          </Button>
          <ConnectorDetail server={server} onDeleted={() => setSelected(null)} />
        </>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {servers.map((s) => (
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- list item is a drag target, button handles keyboard navigation
              <li
                key={s.id}
                data-testid={`connector-${s.id}`}
                draggable
                onDragStart={() => setDrag(s.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  void reorder(s.id)
                }}
                className="flex min-w-0 items-center gap-3 rounded-lg border border-border-default p-3"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                  onClick={() => setSelected(s.id)}
                >
                  <span className="break-all font-medium">{s.displayName}</span>
                  <span className="break-all text-micro text-text-muted">
                    {t('mcp.idType', {
                      id: s.id,
                      type: t(s.transport.type === 'stdio' ? 'mcp.local' : 'mcp.remote'),
                    })}
                  </span>
                  <span className="text-ui-sm">
                    {t(`mcp.status.${connectorStatus(s)}` as never, {
                      version: s.status.protocolVersion ?? '',
                      n: s.toolViews.length,
                      error: s.status.error ? t(`mcp.error.${s.status.error.code}`) : '',
                      seconds: Math.ceil((s.status.restartInMs ?? 0) / 1000),
                    })}
                  </span>
                </button>
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`connector-up-${s.id}`}
                    disabled={servers.indexOf(s) === 0}
                    onClick={() => {
                      const target = servers[servers.indexOf(s) - 1]
                      if (target)
                        void mcpAction(
                          invokeRoute(window.tenon, mcpReorder, {
                            ids: reorderConnector(
                              servers.map((v) => v.id),
                              s.id,
                              target.id,
                            ),
                          }),
                        ).then(setError)
                    }}
                  >
                    {t('mcp.up')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`connector-down-${s.id}`}
                    disabled={servers.indexOf(s) === servers.length - 1}
                    onClick={() => {
                      const target = servers[servers.indexOf(s) + 1]
                      if (target)
                        void mcpAction(
                          invokeRoute(window.tenon, mcpReorder, {
                            ids: reorderConnector(
                              servers.map((v) => v.id),
                              s.id,
                              target.id,
                            ),
                          }),
                        ).then(setError)
                    }}
                  >
                    {t('mcp.down')}
                  </Button>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Switch
                    checked={s.enabled}
                    aria-label={t('mcp.enabled', { name: s.displayName })}
                    onCheckedChange={(enabled) =>
                      void mcpAction(
                        invokeRoute(window.tenon, mcpSetEnabled, { id: s.id, enabled }),
                      ).then(setError)
                    }
                  />
                  <span className="text-micro text-text-muted">{t(MCP_EFFECTIVE_NEXT)}</span>
                </div>
              </li>
            ))}
          </ul>
          {servers.length === 0 ? <p>{t('mcp.empty')}</p> : null}
          {overLimit.map((limit) => (
            <p key={limit.providerId}>
              {t('mcp.overLimit', {
                provider: providers[limit.providerId] ?? limit.providerId,
                n: limit.omitted,
              })}
            </p>
          ))}
          <p className="text-micro text-text-muted">{t('mcp.drag')}</p>
          <Button data-testid="connector-add" onClick={() => setAdding(true)}>
            {t('mcp.add')}
          </Button>
        </>
      )}
      {error ? <p role="alert">{t(`mcp.error.${error}` as never)}</p> : null}
      {adding ? <ConnectorForm open onOpenChange={setAdding} /> : null}
    </div>
  )
}
