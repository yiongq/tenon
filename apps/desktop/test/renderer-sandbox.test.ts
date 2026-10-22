import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { i18n as I18n } from 'i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { SandboxView, ToolOutcomeViewContract } from '@tenon-app/contracts'
import { sandboxReasonCodeSchema } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import { SETTINGS_PANES, SETTINGS_SECTIONS } from '../src/renderer/src/lib/settings-sections.js'
import {
  needsProxyWarning,
  observeSandbox,
  usernsFixCommands,
  writeSandboxSettings,
} from '../src/renderer/src/lib/sandbox-settings.js'

let language: I18n
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: language.t.bind(language) }) }))
const componentPath = '../src/renderer/src/components/settings/SandboxPane.tsx'
const view: SandboxView = {
  posture: { state: 'active', profile: 'workspace-write' },
  platform: 'linux',
  reasons: [],
  settings: { profile: 'workspace-write', allowedDomains: [], packageManagers: false },
  preset: { domains: ['registry.npmjs.org', 'pypi.org'], writable: ['/tenon/sandbox-cache/npm'] },
}
const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>(
  async (_channel: string, _input: unknown): Promise<unknown> => ({
    ok: true,
    data: { ok: true },
  }),
)
let SandboxFields: (props: Record<string, unknown>) => ReactElement
function fields(snapshot = view, error: unknown = null) {
  return SandboxFields({
    view: snapshot,
    draft: 'new.example.com',
    busy: false,
    error,
    onDraft: vi.fn<(value: string) => void>(),
    onSave: (patch: Parameters<typeof writeSandboxSettings>[1]) =>
      writeSandboxSettings({ invoke }, patch),
  }) as ReactElement
}
function html(tree: ReactElement) {
  return renderToStaticMarkup(tree)
}
function nodes(
  tree: ReactNode,
  match: (props: Record<string, unknown>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, match))
  if (!isValidElement<Record<string, unknown>>(tree)) return []
  return [...(match(tree.props) ? [tree] : []), ...nodes(tree.props.children as ReactNode, match)]
}
function node(tree: ReactElement, attr: string, value: unknown) {
  const found = nodes(tree, (props) => props[attr] === value)[0]
  expect(found, `${attr}=${value}`).toBeDefined()
  return found!
}
function change(
  element: ReactElement<Record<string, unknown>>,
  target: Record<string, unknown> = {},
) {
  return (element.props.onChange as (event: unknown) => Promise<unknown>)({ target })
}
beforeAll(async () => {
  ;({ SandboxFields } = await import(componentPath))
  language = await createI18n('en', (message) => {
    throw new Error(message)
  })
})

describe('04 sandbox settings', () => {
  it('04 验收 30: one 权限与网络 pane, no separate sandbox or allowlist pane', async () => {
    expect(SETTINGS_PANES).toEqual(['providers', 'connectors', 'permissions'])
    expect(SETTINGS_SECTIONS.filter((section) => section.id === 'permissions')).toEqual([
      { id: 'permissions', labelKey: 'sandbox.title', menuKey: 'sandbox.title' },
    ])
    expect(language.t('sandbox.title')).toBe('Permissions & network')
    await language.changeLanguage('zh-CN')
    expect(language.t('sandbox.title')).toBe('权限与网络')
    await language.changeLanguage('en')
  })

  it('04 验收 30: no status line while active or pending; one line with the reason when degraded or unavailable, the fix behind the expander', async () => {
    for (const state of ['active', 'pending'] as const) {
      expect(html(fields({ ...view, posture: { ...view.posture, state } }))).not.toContain(
        'data-testid="sandbox-status"',
      )
    }
    for (const state of ['degraded', 'unavailable'] as const) {
      const tree = fields({
        ...view,
        posture: { ...view.posture, state },
        reasons: [{ code: 'missing-rg', detail: 'ripgrep not found <script>bad</script>' }],
      })
      const status = node(tree, 'data-testid', 'sandbox-status')
      expect(status.type).toBe('details')
      expect(status.props.open).toBeUndefined()
      const markup = html(tree)
      expect(markup.match(/data-testid="sandbox-status"/g)).toHaveLength(1)
      expect(markup).toContain('ripgrep was not found.')
      const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(markup)![1]!
      expect(summary).not.toContain('sudo apt-get')
      expect(markup).toContain('sudo apt-get install ripgrep')
      expect(markup).toContain('&lt;script&gt;bad&lt;/script&gt;')
    }
  })

  it('04 验收 30: each state and reason code has its sentence and fix', async () => {
    expect(sandboxReasonCodeSchema.options).toEqual([
      'windows',
      'unsupported-platform',
      'wsl1',
      'root-without-setfcap',
      'missing-bwrap',
      'missing-socat',
      'missing-rg',
      'userns-restricted',
      'nested-sandbox',
      'self-test-failed',
      'init-failed',
      'other',
      'no-seccomp',
      'old-bwrap',
      'test-seam',
    ])
    const expectations = [
      ['windows', 'Sandbox is not supported on Windows yet.', 'macOS or a supported Linux'],
      [
        'unsupported-platform',
        'Sandbox is not supported on this system.',
        'macOS or a supported Linux',
      ],
      ['wsl1', 'WSL 1 cannot', 'WSL 2'],
      ['root-without-setfcap', 'lacks CAP_SETFCAP', 'regular user'],
      ['missing-bwrap', 'bubblewrap was not found', 'sudo apt-get install bubblewrap'],
      ['missing-socat', 'socat was not found', 'sudo apt-get install socat'],
      ['missing-rg', 'ripgrep was not found', 'sudo apt-get install ripgrep'],
      ['userns-restricted', 'restricts user namespaces', '/etc/apparmor.d/bwrap'],
      ['nested-sandbox', 'cannot start another sandbox', 'system terminal'],
      [
        'self-test-failed',
        'The sandbox self-test failed.',
        'repair the system sandbox configuration',
      ],
      ['init-failed', 'The sandbox could not start.', 'repair dependencies'],
      ['other', 'The sandbox reported an unrecognized diagnostic.', 'original diagnostic'],
      [
        'no-seccomp',
        'Unix sockets, and blocked writes are no longer reported',
        'apply-seccomp helper',
      ],
      ['old-bwrap', 'too old', '0.5.0 or later'],
      ['test-seam', 'without real isolation', 'TENON_TEST_SANDBOX removed'],
    ] as const
    for (const [code, sentence, fix] of expectations) {
      const tree = fields({
        ...view,
        posture: { ...view.posture, state: 'unavailable' },
        reasons: [{ code, detail: null }],
      })
      const reason = node(tree, 'data-testid', `sandbox-reason-${code}`)
      expect(html(tree)).toContain(sentence)
      expect(html(reason)).toContain(fix)
    }
    const commands = usernsFixCommands(
      'apparmor_restrict_unprivileged_userns=1\nmax_user_namespaces=0\nbwrap=/usr/local/bin/bwrap',
    )
    expect(commands).toBe(
      "sudo tee /etc/apparmor.d/bwrap <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/local/bin/bwrap flags=(unconfined) {\n  userns,\n}\nEOF\nsudo systemctl reload apparmor",
    )
    expect(usernsFixCommands('bwrap=(none)')).toBeNull()
    expect(usernsFixCommands('bwrap=/bin/bwrap; touch /tmp/bad')).toBeNull()
    const markup = html(
      fields({
        ...view,
        posture: { ...view.posture, state: 'unavailable' },
        reasons: [
          {
            code: 'userns-restricted',
            detail: 'max_user_namespaces=0\nbwrap=/usr/local/bin/bwrap',
          },
        ],
      }),
    )
    expect(markup).toContain('max_user_namespaces=0')
    expect(markup).toContain('profile bwrap /usr/local/bin/bwrap flags=(unconfined)')
    expect(markup).toContain('Tenon does not run them')
  })

  it('04 验收 30: the profile radio under 高级 writes config', async () => {
    invoke.mockClear()
    const tree = fields()
    const advanced = node(tree, 'data-testid', 'sandbox-advanced')
    expect(advanced.type).toBe('details')
    expect(advanced.props.open).toBeUndefined()
    await change(node(advanced, 'value', 'read-only'))
    await change(node(advanced, 'value', 'workspace-write'))
    expect(invoke.mock.calls).toEqual([
      ['sandbox.setSettings', { profile: 'read-only' }],
      ['sandbox.setSettings', { profile: 'workspace-write' }],
    ])
    expect(html(advanced)).toContain('Workspace write (default)')
    expect(html(advanced)).toContain('cannot change the workspace')
  })

  it('04 验收 30: allowlist errors show inline', async () => {
    invoke.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, code: 'invalid-domain', index: 1 },
    })
    const error = await writeSandboxSettings(
      { invoke },
      { allowedDomains: ['example.com', '*.com'] },
    )
    expect(error).toEqual({ ok: false, code: 'invalid-domain', index: 1 })
    const markup = html(fields(view, error))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Address 2 is invalid. Check its format.')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('aria-describedby="sandbox-error"')
    for (const [code, text] of [
      ['too-many', 'Up to 256 addresses'],
      ['write-failed', 'could not be saved'],
    ] as const) {
      expect(html(fields(view, { code }))).toContain(text)
    }
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'handler-failed', message: 'failed' },
    })
    expect(await writeSandboxSettings({ invoke }, { profile: 'read-only' })).toEqual({
      code: 'write-failed',
    })
    invoke.mockRejectedValueOnce(new Error('disconnected'))
    expect(await writeSandboxSettings({ invoke }, { packageManagers: true })).toEqual({
      code: 'write-failed',
    })
  })

  it('04 验收 30: the pane says the list is per site, not per action, and covers commands only', async () => {
    const markup = html(fields())
    expect(markup).toContain('per site, not per action')
    expect(markup).toContain('upload content')
    expect(markup).toContain('commands only, not WebFetch or connectors (MCP)')
    expect(markup).toContain('next command')
    for (const entry of [
      'localhost:3000',
      'service.localhost:80',
      '127.0.0.1:80',
      '10.0.0.1:80',
      '172.16.0.1:80',
      '192.168.1.1:80',
      '169.254.0.1:80',
      '[::1]:80',
      '[fc00::1]:80',
      '[fe80::1]:80',
      '[::ffff:192.168.1.1]:80',
    ])
      expect(needsProxyWarning(entry)).toBe(true)
    for (const entry of [
      'example.com',
      '*.example.com',
      '8.8.8.8',
      '172.32.0.1',
      '[2001:4860:4860::8888]',
      // Older configs may hold names URL cannot read; the pane must still render.
      '192.168.1.256',
      'example.123',
    ])
      expect(needsProxyWarning(entry)).toBe(false)
    const local = html(
      fields({ ...view, settings: { ...view.settings, allowedDomains: ['localhost:3000'] } }),
    )
    expect(local).toContain('only for clients using the proxy')
    expect(local).toContain('local or private services')
  })

  it('04 验收 30: the preset expander says the npm registry also accepts publishing', async () => {
    const tree = fields()
    const preset = node(tree, 'data-testid', 'sandbox-preset')
    expect(preset.type).toBe('details')
    expect(preset.props.open).toBeUndefined()
    expect(html(preset)).toContain('registry.npmjs.org also accepts npm publishing')
    expect(html(preset)).toContain('pypi.org')
    expect(html(preset)).toContain('/tenon/sandbox-cache/npm')
    expect(html(preset)).toContain('Read only does not grant this access')
    invoke.mockClear()
    await change(node(tree, 'data-testid', 'sandbox-package-managers'), { checked: true })
    expect(invoke.mock.calls).toEqual([['sandbox.setSettings', { packageManagers: true }]])
  })

  it('04 验收 30: under the fake seam (reasons carry test-seam) the pane shows one test-seam line while active', async () => {
    const markup = html(fields({ ...view, reasons: [{ code: 'test-seam', detail: 'fake' }] }))
    expect(markup.match(/data-testid="sandbox-status"/g)).toHaveLength(1)
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(markup)![1]!
    expect(summary).toContain('Sandbox active')
    expect(summary).toContain('This is a test seam. Commands run directly without real isolation.')
    expect(markup).toContain('fake')
    await language.changeLanguage('zh-CN')
    try {
      const zhMarkup = html(fields({ ...view, reasons: [{ code: 'test-seam', detail: 'fake' }] }))
      const zhSummary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(zhMarkup)![1]!
      expect(zhSummary).toContain('沙箱已生效')
      expect(zhSummary).toContain('这是测试接缝，命令直接运行，不提供真实隔离。')
    } finally {
      await language.changeLanguage('en')
    }
  })

  it('04 验收 30: add and remove write only the edited allowlist', async () => {
    invoke.mockClear()
    const tree = fields({
      ...view,
      settings: { ...view.settings, allowedDomains: ['example.com', 'localhost:3000'] },
    })
    const form = nodes(tree, (props) => typeof props.onSubmit === 'function')[0]!
    await (form.props.onSubmit as (event: unknown) => Promise<unknown>)({
      preventDefault: vi.fn<() => void>(),
    })
    await (node(tree, 'aria-label', 'Remove example.com').props.onClick as () => Promise<unknown>)()
    expect(invoke.mock.calls).toEqual([
      [
        'sandbox.setSettings',
        { allowedDomains: ['example.com', 'localhost:3000', 'new.example.com'] },
      ],
      ['sandbox.setSettings', { allowedDomains: ['localhost:3000'] }],
    ])
  })

  it('04 验收 30: changes update the pane; stale reads and disposed subscriptions cannot overwrite them', async () => {
    let pushed = vi.fn<(payload: unknown) => void>() as (payload: unknown) => void
    let finish = vi.fn<(value: unknown) => void>() as (value: unknown) => void
    const detach = vi.fn<() => void>(),
      publish = vi.fn<(view: SandboxView) => void>(),
      failed = vi.fn<() => void>()
    const bridge = {
      invoke: vi.fn<(channel: string, input: unknown) => Promise<unknown>>(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
      on: vi.fn<(channel: string, listener: (payload: unknown) => void) => () => void>(
        (channel: string, listener: (payload: unknown) => void) => {
          expect(channel).toBe('sandbox.changed')
          pushed = listener
          return detach
        },
      ),
    }
    const observer = observeSandbox(bridge, publish, failed)
    const pending = observer.refresh()
    const changed = { ...view, settings: { ...view.settings, profile: 'read-only' } }
    pushed(changed)
    finish({ ok: true, data: view })
    await pending
    expect(publish.mock.calls).toEqual([[changed]])
    expect(bridge.invoke.mock.calls).toEqual([['sandbox.get', {}]])
    pushed({ ...view, proxyToken: 'unexpected', posture: null })
    expect(publish).toHaveBeenCalledTimes(1)
    const afterClose = observer.refresh()
    observer.dispose()
    finish({ ok: true, data: view })
    await afterClose
    pushed(view)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    const bad = observeSandbox(
      { ...bridge, invoke: async () => ({ ok: true, data: {} }) },
      publish,
      failed,
    )
    await bad.refresh()
    expect(failed).toHaveBeenCalledTimes(1)
    bad.dispose()
  })
})

// Exercise the real receipt and its handlers. Only the bridge, session and hook state are controlled.
type Outcome = ToolOutcomeViewContract
type Sandbox = NonNullable<Outcome['sandbox']>
type Violation = Sandbox['violations'][number]
let receiptStates = new Map<string, string>()
vi.mock('react', async (original) => {
  const actual = await original<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) =>
      initial instanceof Map
        ? [
            receiptStates,
            (update: (was: Map<string, string>) => Map<string, string>) => {
              receiptStates = update(receiptStates)
            },
          ]
        : actual.useState(initial),
  }
})
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1' }),
  useSessionSnapshot: () => ({
    pending: null,
    facts: { profile: 'cowork' },
    answered: new Map(),
    asked: new Map(),
  }),
}))
vi.mock('../src/renderer/src/runtime/mcp-store', () => ({ useMcp: () => ({ servers: [] }) }))
const rowPath = '../src/renderer/src/components/thread/ToolRow.tsx'
let SandboxNotice: (props: { callKey: string; outcome: Outcome; sandbox: Sandbox }) => ReactElement
beforeAll(async () => {
  ;({ SandboxNotice } = await import(rowPath))
})
const domainViolation: Violation = {
  kind: 'network',
  target: 'registry.example.com',
  release: 'domain',
  protected: false,
  observed: false,
}
const pathViolation: Violation = {
  kind: 'fs',
  target: '/outside/full/path.txt',
  release: 'path',
  protected: false,
  observed: false,
}
function receipt(
  violations: Violation[],
  patch: Partial<Outcome> = {},
  more = 0,
  anyProtected = violations.some((v) => v.protected),
) {
  const sandbox = { violations, more, anyProtected }
  const outcome: Outcome = {
    effect: 'blocked',
    state: 'completed',
    source: 'sandbox',
    output: 'Exit code: 1\nfailed',
    sandbox,
    ...patch,
  }
  return SandboxNotice({ callKey: 'run:1:0', outcome, sandbox })
}
function buttons(tree: ReactElement) {
  return nodes(
    tree,
    (props) =>
      String(props['data-testid']).startsWith('receipt-') && typeof props.onClick === 'function',
  )
}
function texts(tree: ReactElement) {
  return html(tree)
    .replace(/<[^>]*>/g, '')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
}

describe('04 receipts', () => {
  it('04 验收 31: buttons follow the rules: domain, path (not observed), rerun only without protected', () => {
    receiptStates = new Map()
    expect(
      buttons(receipt([domainViolation, pathViolation])).map((b) => b.props['data-testid']),
    ).toEqual(['receipt-allow-domain', 'receipt-allow-path', 'receipt-rerun-unsandboxed'])
    expect(
      buttons(receipt([{ ...pathViolation, observed: true }])).map((b) => b.props['data-testid']),
    ).toEqual(['receipt-rerun-unsandboxed'])
    for (const target of [
      'localhost',
      'service.localhost',
      '1.1.1.1',
      '127.0.0.1',
      '::1',
      'bad_host',
      'resolved.example.com',
    ]) {
      expect(
        buttons(receipt([{ ...domainViolation, target, release: null }])).map(
          (b) => b.props['data-testid'],
        ),
      ).toEqual(['receipt-rerun-unsandboxed'])
    }
    const protectedTree = receipt([{ ...pathViolation, release: null, protected: true }])
    expect(buttons(protectedTree)).toEqual([])
    expect(texts(protectedTree)).toContain('Access to these files cannot be allowed here.')
    // The summary includes violations beyond the retained list.
    expect(
      buttons(receipt([domainViolation], {}, 1, true)).map((b) => b.props['data-testid']),
    ).toEqual(['receipt-allow-domain'])
  })

  it('04 验收 31: a clicked button reads 已放行, already-released too', async () => {
    const releaseInvoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>()
    vi.stubGlobal('window', { tenon: { invoke: releaseInvoke } })
    try {
      for (const status of ['released', 'already-released']) {
        receiptStates = new Map()
        releaseInvoke.mockResolvedValue({ ok: true, data: { status } })
        const tree = receipt([domainViolation, pathViolation])
        for (const button of buttons(tree)) {
          // oxlint-disable-next-line no-await-in-loop -- each handler uses the current controlled bridge response
          await (button.props.onClick as () => Promise<void>)()
        }
        expect(
          buttons(receipt([domainViolation, pathViolation])).map((b) => b.props.disabled),
        ).toEqual([true, true, true])
        expect(texts(receipt([domainViolation, pathViolation])).match(/Allowed/g)).toHaveLength(3)
      }
      expect(releaseInvoke.mock.calls.slice(0, 3)).toEqual([
        [
          'sandbox.release',
          {
            sessionId: 'session-1',
            callKey: 'run:1:0',
            action: 'allow-domain',
            target: 'registry.example.com',
          },
        ],
        [
          'sandbox.release',
          {
            sessionId: 'session-1',
            callKey: 'run:1:0',
            action: 'allow-path',
            target: '/outside/full/path.txt',
          },
        ],
        [
          'sandbox.release',
          { sessionId: 'session-1', callKey: 'run:1:0', action: 'rerun-unsandboxed', target: null },
        ],
      ])
      await language.changeLanguage('zh-CN')
      expect(texts(receipt([domainViolation, pathViolation])).match(/已放行/g)).toHaveLength(3)
    } finally {
      await language.changeLanguage('en')
      vi.unstubAllGlobals()
      receiptStates = new Map()
    }
  })

  it('04 验收 31: release errors show inline and leave the button retryable', async () => {
    const releaseInvoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>()
    vi.stubGlobal('window', { tenon: { invoke: releaseInvoke } })
    try {
      for (const [status, expected] of [
        ['stale', 'This call can no longer be allowed. Request the command again.'],
        ['not-found', 'This call was not found. Request the command again.'],
        ['refused', 'Permission cannot be granted now. Try again later.'],
      ]) {
        receiptStates = new Map()
        releaseInvoke.mockResolvedValue({ ok: true, data: { status } })
        // oxlint-disable-next-line no-await-in-loop -- each handler uses the current controlled bridge response
        await (buttons(receipt([domainViolation]))[0]!.props.onClick as () => Promise<void>)()
        const after = receipt([domainViolation])
        expect(texts(node(after, 'role', 'alert'))).toBe(expected)
        expect(buttons(after)[0]!.props.disabled).toBe(false)
      }
      for (const response of [
        Promise.resolve({ ok: false, error: { code: 'handler-failed' } }),
        () => Promise.reject(new Error('disconnected')),
      ]) {
        receiptStates = new Map()
        releaseInvoke.mockImplementation(() =>
          typeof response === 'function' ? response() : response,
        )
        // oxlint-disable-next-line no-await-in-loop -- each handler uses the current controlled bridge response
        await (buttons(receipt([domainViolation]))[0]!.props.onClick as () => Promise<void>)()
        expect(texts(node(receipt([domainViolation]), 'role', 'alert'))).toBe(
          'Permission could not be granted. Try again.',
        )
      }
    } finally {
      vi.unstubAllGlobals()
      receiptStates = new Map()
    }
  })

  it('04 验收 31: an observed-only call still shows the receipt', () => {
    const tree = receipt([{ ...domainViolation, release: null, observed: true }], {
      source: null,
      output: 'ok',
    })
    expect(texts(tree)).toContain('Could not connect to registry.example.com')
    expect(html(tree)).toContain('data-testid="sandbox-notice"')
  })

  it('04 验收 31: an all-observed call that exited 0 is a hint only, with no rerun button; a non-zero exit, or one violation without observed, brings the button back', () => {
    const diagnostic = { ...domainViolation, target: null, release: null, observed: true }
    expect(
      buttons(receipt([diagnostic], { source: null, output: 'installed\nExit code: 1' })),
    ).toEqual([])
    for (const output of [
      'Exit code: 1\nfailed',
      'Exit code: 10\nfailed',
      'Killed by signal: SIGKILL\nkilled',
    ]) {
      expect(
        buttons(receipt([diagnostic], { source: null, output })).map((b) => b.props['data-testid']),
      ).toEqual(['receipt-rerun-unsandboxed'])
    }
    expect(
      buttons(receipt([diagnostic, domainViolation], { output: 'ok' })).map(
        (b) => b.props['data-testid'],
      ),
    ).toEqual(['receipt-allow-domain', 'receipt-rerun-unsandboxed'])
    for (const source of ['stopped', 'timed-out'] as const) {
      expect(
        buttons(receipt([diagnostic], { source, output: 'partial' })).map(
          (b) => b.props['data-testid'],
        ),
      ).toEqual(['receipt-rerun-unsandboxed'])
    }
  })

  it('04 验收 31: each button carries the line saying when it takes effect, what it adds and when it lapses', () => {
    const notes = nodes(
      receipt([domainViolation, pathViolation]),
      (props) => props['data-testid'] === 'receipt-action-note',
    ).map(texts)
    expect(notes).toEqual([
      'From now on, commands in this task can connect and upload to it. This lasts for this task only; it is not saved to the list in Settings.',
      'Applies once when this exact command runs again in this task, adding only this location. Unused permission expires at the end of the next reply; it is not remembered.',
      'Applies when this exact command runs again in this task: it can read and write every file you can access and connect to any site. You will be asked again before it runs. Unused permission expires at the end of the next reply; it is not remembered.',
    ])
    expect(texts(receipt([pathViolation]))).toContain(
      'Allow writing to this location only: /outside/full/path.txt',
    )
  })

  it('04 验收 31: a receipt with a sandbox member renders neither blocked.<source> nor blocked.told; an observed-only call never looks up blocked.null', async () => {
    const { ToolRow } = await import(rowPath)
    const { createElement } = await import('react')
    for (const source of ['policy', 'sandbox', null] as const) {
      const markup = html(
        createElement(ToolRow, {
          toolCallId: 'run:1:0',
          toolName: 'Bash',
          args: {},
          result: {
            effect: 'blocked',
            state: 'completed',
            source,
            output: 'ok',
            sandbox: {
              violations: [{ ...domainViolation, observed: true }],
              more: 0,
              anyProtected: false,
            },
          },
        }),
      )
      expect(markup).toContain('data-testid="sandbox-notice"')
      expect(markup).not.toContain('data-testid="blocked-notice"')
      expect(markup).not.toContain('data-testid="tool-row-closure"')
      expect(markup).not.toContain('Your organization doesn&#x27;t allow this step.')
      expect(markup).not.toContain('The model was told.')
      expect(markup).not.toContain('blocked.null')
    }
  })

  it('04 验收 31: the why line follows the class: a public IP literal and a loopback or private one get different sentences', () => {
    for (const target of ['1.1.1.1', '2001:4860:4860::8888']) {
      expect(
        texts(
          node(
            receipt([{ ...domainViolation, target, release: null }]),
            'data-testid',
            'receipt-why',
          ),
        ),
      ).toBe(
        'This address is not on the allowed list. To allow an IP address, add it in Settings → Permissions & network.',
      )
    }
    for (const target of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:192.168.1.1',
      'localhost',
      'service.localhost',
    ]) {
      expect(
        texts(
          node(
            receipt([{ ...domainViolation, target, release: null }]),
            'data-testid',
            'receipt-why',
          ),
        ),
      ).toBe(
        'This address points to this computer or a private network and cannot be allowed here.',
      )
    }
    expect(texts(node(receipt([domainViolation]), 'data-testid', 'receipt-why'))).toBe(
      'This site is not on the list of allowed connections.',
    )
    expect(
      texts(
        node(
          receipt([{ ...domainViolation, target: 'resolved.example.com', release: null }]),
          'data-testid',
          'receipt-why',
        ),
      ),
    ).toBe(
      'This name points to this computer or a private network, or is not recognized. It cannot be allowed here.',
    )
  })

  it('04 验收 31: file violations are classed by release and protected only: a path release, a protected one and the rest (a credential read and a write on the home dir share a sentence)', () => {
    expect(texts(node(receipt([pathViolation]), 'data-testid', 'receipt-why'))).toBe(
      'This location cannot be changed: it is outside this task’s folders, or file access is set to read only.',
    )
    expect(
      texts(
        node(
          receipt([{ ...pathViolation, release: null, protected: true }]),
          'data-testid',
          'receipt-why',
        ),
      ),
    ).toBe(
      'This location is protected: it holds sign-in credentials or Tenon’s data, or changing it affects what runs automatically on your computer.',
    )
    for (const target of [
      '/home/me/.ssh/id_ed25519',
      '/home/me/.aws/credentials',
      '/home/me',
      '/some/directory',
    ]) {
      expect(
        texts(
          node(
            receipt([{ ...pathViolation, target, release: null }]),
            'data-testid',
            'receipt-why',
          ),
        ),
      ).toBe(
        'This location is outside the files accessible this time (such as sign-in credentials). Access to it alone cannot be allowed here.',
      )
    }
  })

  it('04 验收 31: 写入 only with a path release; any other file violation reads 访问', async () => {
    await language.changeLanguage('zh-CN')
    try {
      expect(texts(node(receipt([pathViolation]), 'data-testid', 'receipt-objects'))).toBe(
        '没能写入 /outside/full/path.txt',
      )
      expect(
        texts(
          node(receipt([{ ...pathViolation, release: null }]), 'data-testid', 'receipt-objects'),
        ),
      ).toBe('没能访问 /outside/full/path.txt')
    } finally {
      await language.changeLanguage('en')
    }
  })

  it('04 验收 31: three objects and three deduplicated targets per button kind, counts for the rest and unknown objects', () => {
    const tree = receipt(
      [
        domainViolation,
        domainViolation,
        ...['two.example.com', 'three.example.com', 'four.example.com'].map((target) =>
          Object.assign({}, domainViolation, { target }),
        ),
        ...['/one', '/two', '/three', '/four'].map((target) =>
          Object.assign({}, pathViolation, { target }),
        ),
        { ...domainViolation, target: null, release: null },
      ],
      {},
      4,
    )
    expect(texts(node(tree, 'data-testid', 'receipt-objects'))).toBe(
      'Could not connect to registry.example.comCould not connect to registry.example.comCould not connect to two.example.com10 more operations could not complete1 other operations could not complete; their targets were not recorded',
    )
    expect(buttons(tree).map((b) => b.props['data-testid'])).toEqual([
      'receipt-allow-domain',
      'receipt-allow-domain',
      'receipt-allow-domain',
      'receipt-allow-path',
      'receipt-allow-path',
      'receipt-allow-path',
      'receipt-rerun-unsandboxed',
    ])
    const unknown = receipt([{ ...domainViolation, target: null, release: null }])
    expect(texts(node(unknown, 'data-testid', 'receipt-why'))).toBe('')
  })
})
