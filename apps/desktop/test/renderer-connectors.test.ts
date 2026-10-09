import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import {
  mcpErrorCodeSchema,
  mcpPhaseSchema,
  mcpWriteErrorCodeSchema,
  mcpLoginErrorSchema,
} from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import {
  TOOL_SETTING_KEY,
  MCP_EFFECTIVE_NEXT,
  MCP_NEVER_NOTE,
  MCP_ACTIONS,
  reorderConnector,
  connectorStatus,
  toolSettings,
  unavailableKey,
  draftOf,
} from '../src/renderer/src/lib/connectors.js'
import {
  secretNames,
  enteredSecrets,
  grantEnvironment,
  resolvedCopy,
  GRANT_BUTTONS,
  GRANT_DEFAULT,
  grantArgv,
  grantResult,
  launchChanged,
} from '../src/renderer/src/lib/connector-consent.js'
import { serverView } from './support/mcp-view.js'

const tool = {
  originalName: 'echo',
  mappedName: 'notes__echo',
  setting: 'ask',
  definitionHash: 'a'.repeat(64),
  review: 'ok',
  requiresUserInteraction: false,
  alwaysAllowOffered: true,
  unavailable: null,
  description: 'Echo',
} as const

describe('connector controls', () => {
  it('03 验收 44: every phase and error has copy; tri-state, new-session notes and actions are offered', async () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- separate locale instances
      const i = await createI18n(locale, () => {})
      for (const phase of mcpPhaseSchema.options)
        expect(i.t(`mcp.status.${phase}` as never)).not.toBe(`mcp.status.${phase}`)
      for (const code of [
        ...mcpErrorCodeSchema.options,
        ...mcpWriteErrorCodeSchema.options,
        ...mcpLoginErrorSchema.options,
      ])
        expect(i.t(`mcp.error.${code}` as never)).not.toBe(`mcp.error.${code}`)
      for (const key of [
        ...Object.values(TOOL_SETTING_KEY),
        MCP_EFFECTIVE_NEXT,
        MCP_NEVER_NOTE,
        'mcp.drag',
        'mcp.overLimit',
        ...MCP_ACTIONS.map((a) => `mcp.${a}`),
      ])
        expect(i.t(key as never)).not.toBe(key)
    }
    expect(MCP_EFFECTIVE_NEXT).toBe('mcp.nextSession')
    expect(toolSettings(tool)).toEqual(['always-allow', 'ask', 'never'])
    const s = serverView()
    expect(connectorStatus(s)).toBe('connected')
    expect(connectorStatus({ ...s, enabled: false })).toBe('disabled')
    expect(connectorStatus({ ...s, needsConsent: true })).toBe('needs-consent')
    expect(
      connectorStatus({
        ...s,
        status: { ...s.status, phase: 'stopped', stopReason: 'crash-limit' },
      }),
    ).toBe('crash-limit')
  })
  it('no always-allow item for requiresUserInteraction or policy-asks tools', () => {
    expect(
      toolSettings({ ...tool, requiresUserInteraction: true, alwaysAllowOffered: false }),
    ).toEqual(['ask', 'never'])
    expect(toolSettings({ ...tool, alwaysAllowOffered: false })).toEqual(['ask', 'never'])
  })
  it('03 验收 13/31: legacy repair and name-collision copy', async () => {
    const i = await createI18n('zh-CN', () => {})
    expect(i.t('mcp.changeLegacy')).toBe('改为只用旧代')
    expect(i.t(unavailableKey('name-collision'))).toBe('重名，未提供')
  })
  it('03 验收 25 (render): full argv escapes hidden characters without truncation', () => {
    const long = 'x'.repeat(4096)
    expect(grantArgv(['/usr/bin/node', 'a\u202Eb\t\n', long])).toEqual([
      '/usr/bin/node',
      'a\\u{202E}b\\u{0009}⏎\n',
      long,
    ])
  })
  it('cancel maps to no save and the default button is 取消', () => {
    expect(GRANT_BUTTONS).toEqual(['cancel', 'persistent', 'run'])
    expect(GRANT_DEFAULT).toBe('cancel')
    expect(grantResult('cancel')).toBeNull()
    expect(grantResult('persistent')).toBe('persistent')
    expect(grantResult('run')).toBe('run')
  })
  it('launch edits require confirmation; display names, timeout and header names do not alter launch', () => {
    const s = serverView(),
      d = draftOf(s)
    expect(launchChanged(undefined, d)).toBe(true)
    expect(launchChanged(s, d)).toBe(false)
    expect(launchChanged(s, { ...d, displayName: 'Changed', callTimeoutSec: 1 })).toBe(false)
    expect(
      launchChanged(s, {
        ...d,
        transport: {
          type: 'stdio',
          command: '/usr/bin/node',
          args: ['new'],
          envs: {},
          env_keys: [],
        },
      }),
    ).toBe(true)
  })
})

it('03 验收 25 (render): resolved path, key names without values, and every warning are visible', async () => {
  expect(resolvedCopy('/node')).toEqual({ key: 'mcp.resolved', args: { path: '/node' } })
  expect(resolvedCopy(null)).toEqual({ key: 'mcp.commandMissing', args: {} })
  expect(
    grantEnvironment({
      type: 'stdio',
      command: 'node',
      args: [],
      envs: { LOG: 'info' },
      env_keys: ['TOKEN'],
    }),
  ).toEqual({ plain: ['LOG=info'], keys: ['TOKEN'] })
  const i = await createI18n('zh-CN', () => {})
  for (const kind of [
    'sudo',
    'rm-rf',
    'home-path',
    'ssh-path',
    'unpinned-package',
    'risky-env',
  ] as const)
    expect(
      i.t(`mcp.warning.${kind}`, { arg: '~/.ssh', package: 'fixture', name: 'PATH' }),
    ).not.toBe(`mcp.warning.${kind}`)
})

it('sort supports adjacent down/up and reaching either end without dropping IDs', () => {
  expect(reorderConnector(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c'])
  expect(reorderConnector(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  expect(reorderConnector(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
})
it('only changing envs values or adding a secret name changes launch; secrets are built from named password fields', () => {
  const s = serverView(),
    d = draftOf(s)
  expect(
    launchChanged(s, {
      ...d,
      transport: {
        type: 'stdio',
        command: '/usr/bin/node',
        args: [],
        envs: { VALUE: 'changed' },
        env_keys: [],
      },
    }),
  ).toBe(true)
  expect(
    launchChanged(s, {
      ...d,
      transport: {
        type: 'stdio',
        command: '/usr/bin/node',
        args: [],
        envs: {},
        env_keys: ['TOKEN'],
      },
    }),
  ).toBe(true)
  expect(secretNames('["TOKEN","OTHER"]')).toEqual(['TOKEN', 'OTHER'])
  expect(
    enteredSecrets(['TOKEN', 'OTHER'], { TOKEN: 'fixture', OTHER: '', REMOVED: 'removed' }),
  ).toEqual({ TOKEN: 'fixture' })
  expect(
    grantEnvironment({
      type: 'stdio',
      command: 'node',
      args: [],
      envs: { VALUE: 'a\u202Eb' },
      env_keys: [],
    }).plain,
  ).toEqual(['VALUE=a\\u{202E}b'])
  expect(resolvedCopy('/a\u202Eb').args).toEqual({ path: '/a\\u{202E}b' })
})

it('03 验收 13: the error detail renders 改为只用旧代 only for HTTP era-negotiation-failed', async () => {
  const i18n = await createI18n('zh-CN', () => {})
  // Runtime import keeps this renderer component in its own JSX/DOM TypeScript project.
  const componentPath = '../src/renderer/src/components/settings/ConnectorDetail.tsx'
  const { ConnectorDetail } = await import(componentPath)
  const remote = serverView({
    transport: {
      type: 'http',
      url: 'https://fixture.example',
      protocol: 'auto',
      header_keys: [],
      oauth: { ownClient: null, issuers: [] },
    },
  })
  const render = (server: ReturnType<typeof serverView>) =>
    renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(ConnectorDetail, { server })),
    )
  expect(
    render({
      ...remote,
      status: {
        ...remote.status,
        phase: 'error',
        error: { code: 'era-negotiation-failed', stderrTail: '' },
      },
    }),
  ).toMatch(/<button[^>]*>改为只用旧代<\/button>/)
  expect(
    render({
      ...remote,
      status: { ...remote.status, phase: 'error', error: { code: 'network', stderrTail: '' } },
    }),
  ).not.toMatch(/<button[^>]*>改为只用旧代<\/button>/)
  expect(
    render(
      serverView({
        status: {
          ...remote.status,
          phase: 'error',
          error: { code: 'era-negotiation-failed', stderrTail: '' },
        },
      }),
    ),
  ).not.toMatch(/<button[^>]*>改为只用旧代<\/button>/)
})
