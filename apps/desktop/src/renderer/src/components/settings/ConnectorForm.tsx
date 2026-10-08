import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invokeRoute, mcpPreview, mcpSave, mcpDraftSchema } from '@tenon-app/contracts'
import type { McpDraft, McpServerView, RouteResponse } from '@tenon-app/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { launchChanged } from '@/lib/connector-consent'
import { mcpAction } from '@/runtime/mcp-store'
import { Field, Chooser } from './fields'
import { GrantDialog } from './GrantDialog'
export function ConnectorForm(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  server?: McpServerView
}) {
  const { t } = useTranslation(),
    prefix = useId(),
    s = props.server,
    transport = s?.transport
  const [kind, setKind] = useState<'stdio' | 'http'>(transport?.type ?? 'stdio')
  const initial = {
    id: s?.id ?? '',
    displayName: s?.displayName ?? '',
    command: transport?.type === 'stdio' ? transport.command : '',
    args: transport?.type === 'stdio' ? JSON.stringify(transport.args) : '[]',
    envs: transport?.type === 'stdio' ? JSON.stringify(transport.envs) : '{}',
    envKeys: transport?.type === 'stdio' ? JSON.stringify(transport.env_keys) : '[]',
    url: transport?.type === 'http' ? transport.url : '',
    headers: transport?.type === 'http' ? JSON.stringify(transport.header_keys) : '[]',
    clientId: transport?.type === 'http' ? (transport.oauth.ownClient?.clientId ?? '') : '',
    port:
      transport?.type === 'http'
        ? String(transport.oauth.ownClient?.redirectPort ?? 53280)
        : '53280',
    handshake: String(s?.handshakeTimeoutSec ?? ''),
    timeout: String(s?.callTimeoutSec ?? ''),
    secretEnv: '{}',
    secretHeaders: '{}',
    clientSecret: '',
  }
  const [values, setValues] = useState(initial),
    [protocol, setProtocol] = useState<'auto' | 'legacy'>(
      transport?.type === 'http' ? transport.protocol : 'auto',
    ),
    [hasSecret, setHasSecret] = useState(
      transport?.type === 'http' && transport.oauth.ownClient?.hasSecret === true,
    )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [grant, setGrant] = useState<{
      draft: McpDraft
      preview: Extract<RouteResponse<typeof mcpPreview>, { ok: true }>
    } | null>(null)
  const edit = (key: keyof typeof initial, value: string) =>
    setValues((old) => ({ ...old, [key]: value }))
  const field = (key: keyof typeof initial, multi = false, secret = false) => (
    <Field key={key} label={t(`mcp.form.${key}` as never)} htmlFor={`${prefix}-${key}`}>
      {multi ? (
        <Textarea
          id={`${prefix}-${key}`}
          data-testid={`mcp-${key}`}
          value={values[key]}
          onChange={(e) => edit(key, e.target.value)}
          rows={3}
        />
      ) : (
        <Input
          id={`${prefix}-${key}`}
          data-testid={`mcp-${key}`}
          type={secret ? 'password' : 'text'}
          autoComplete="off"
          disabled={key === 'id' && !!s}
          value={values[key]}
          onChange={(e) => edit(key, e.target.value)}
        />
      )}
    </Field>
  )
  const draft = (): McpDraft =>
    mcpDraftSchema.parse({
      id: values.id,
      displayName: values.displayName,
      source: 'manual',
      transport:
        kind === 'stdio'
          ? {
              type: 'stdio',
              command: values.command,
              args: JSON.parse(values.args),
              envs: JSON.parse(values.envs),
              env_keys: JSON.parse(values.envKeys),
            }
          : {
              type: 'http',
              url: values.url,
              protocol,
              header_keys: JSON.parse(values.headers),
              oauth: {
                ownClient: values.clientId
                  ? {
                      clientId: values.clientId,
                      redirectPort: Number(values.port),
                      hasSecret: hasSecret || !!values.clientSecret,
                    }
                  : null,
              },
            },
      handshakeTimeoutSec: values.handshake ? Number(values.handshake) : null,
      callTimeoutSec: values.timeout ? Number(values.timeout) : null,
      instructions: { enabled: s?.instructions.enabled ?? false },
    })
  async function save(value: McpDraft, consent: 'run' | 'persistent' | null) {
    setBusy(true)
    setError(null)
    try {
      const code = await mcpAction(
        invokeRoute(window.tenon, mcpSave, {
          mode: s ? 'update' : 'create',
          draft: value,
          consent,
          secrets: {
            env: JSON.parse(values.secretEnv),
            headers: JSON.parse(values.secretHeaders),
            ...(values.clientSecret ? { ownClientSecret: values.clientSecret } : {}),
          },
        }),
      )
      setGrant(null)
      setError(code)
      if (code === null) props.onOpenChange(false)
    } catch {
      setError('invalid-form')
      setGrant(null)
    } finally {
      setBusy(false)
    }
  }
  async function submit() {
    setError(null)
    try {
      const value = draft(),
        result = await invokeRoute(window.tenon, mcpPreview, { draft: value })
      if (!result.ok) {
        setError('unavailable')
        return
      }
      if (!result.data.ok) {
        setError(result.data.code)
        return
      }
      if (value.transport.type === 'http') value.transport.url = result.data.argv[0]!
      if (launchChanged(s, value) || s?.needsConsent)
        setGrant({ draft: value, preview: result.data })
      else await save(value, null)
    } catch {
      setError('invalid-form')
    }
  }
  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={(open) => {
          if (!busy) props.onOpenChange(open)
        }}
      >
        <DialogContent
          data-testid="connector-form"
          closeLabel={t('mcp.cancel')}
          className="sm:max-w-xl max-h-[85vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{t(s ? 'mcp.edit' : 'mcp.add')}</DialogTitle>
            <DialogDescription>{t('mcp.formNote')}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
            className="flex flex-col gap-3"
          >
            {field('id')}
            {field('displayName')}
            <Field label={t('mcp.type')} htmlFor={`${prefix}-type`}>
              <Chooser
                id={`${prefix}-type`}
                testId="mcp-type"
                value={kind}
                options={[
                  { value: 'stdio', label: t('mcp.local') },
                  { value: 'http', label: t('mcp.remote') },
                ]}
                onChange={(v) => setKind(v as 'stdio' | 'http')}
              />
            </Field>
            {kind === 'stdio' ? (
              <>
                {field('command')}
                {field('args', true)}
                {field('envs', true)}
                {field('envKeys', true)}
                {field('secretEnv', true)}
              </>
            ) : (
              <>
                {field('url')}
                {field('headers', true)}
                {field('secretHeaders', true)}
                <Field label={t('mcp.protocol')} htmlFor={`${prefix}-protocol`}>
                  <Chooser
                    id={`${prefix}-protocol`}
                    testId="mcp-protocol"
                    value={protocol}
                    onChange={(v) => setProtocol(v as 'auto' | 'legacy')}
                    options={[
                      { value: 'auto', label: t('mcp.auto') },
                      { value: 'legacy', label: t('mcp.legacy') },
                    ]}
                  />
                </Field>
                {field('clientId')}
                {field('port')}
                {field('clientSecret', false, true)}
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={hasSecret}
                    onChange={(e) => setHasSecret(e.target.checked)}
                  />
                  {t('mcp.hasSecret')}
                </label>
              </>
            )}
            {field('handshake')}
            {field('timeout')}
            {error ? <p role="alert">{t(`mcp.error.${error}` as never)}</p> : null}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => props.onOpenChange(false)}>
                {t('mcp.cancel')}
              </Button>
              <Button type="submit" disabled={busy} data-testid="connector-save">
                {t('mcp.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {grant ? (
        <GrantDialog
          open
          onOpenChange={() => setGrant(null)}
          {...grant}
          busy={busy}
          onChoose={(choice) => {
            if (choice === 'cancel') setGrant(null)
            else void save(grant.draft, choice)
          }}
        />
      ) : null}
    </>
  )
}
