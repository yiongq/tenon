import { describe, expect, it } from 'vitest'
import * as contracts from '../src/index.js'
import { EVENT_CHANNELS, ROUTE_CHANNELS, isEventChannel, isRouteChannel } from '../src/registry.js'

describe('ipc registry', () => {
  it('04 验收 30 (registry): every exported route and event is registered, or the preload rejects it', () => {
    const defs = (Object.values(contracts) as unknown[]).filter(
      (value): value is { kind: 'route' | 'event'; channel: string } =>
        typeof value === 'object' && value !== null && 'kind' in value && 'channel' in value,
    )
    const routes = defs.filter((d) => d.kind === 'route').map((d) => d.channel)
    const events = defs.filter((d) => d.kind === 'event').map((d) => d.channel)
    expect(routes).toContain('sandbox.get')
    expect(routes.filter((channel) => !isRouteChannel(channel))).toEqual([])
    expect(events.filter((channel) => !isEventChannel(channel))).toEqual([])
  })

  it('presentation-r1 不变量 4: lists every declared route and event exactly once', () => {
    expect([...ROUTE_CHANNELS].toSorted()).toEqual([
      'approval.current',
      'approval.list',
      'approval.respond',
      'approval.resume',
      'chat.continue',
      'chat.queue.act',
      'chat.send',
      'chat.sendNow',
      'chat.stop',
      'config.get',
      'config.set',
      'customVendor.cancelProbe',
      'customVendor.create',
      'customVendor.delete',
      'customVendor.fetchModels',
      'customVendor.list',
      'customVendor.probe',
      'customVendor.update',
      'mcp.cancelLogin',
      'mcp.connect',
      'mcp.delete',
      'mcp.list',
      'mcp.login',
      'mcp.preview',
      'mcp.readLog',
      'mcp.refreshTools',
      'mcp.release',
      'mcp.reorder',
      'mcp.restart',
      'mcp.reviewChange',
      'mcp.revoke',
      'mcp.save',
      'mcp.setEnabled',
      'mcp.setInstructions',
      'mcp.setToolSetting',
      'provider.configure',
      'provider.list',
      'provider.select',
      'sandbox.get',
      'sandbox.release',
      'sandbox.setSettings',
      'session.facts',
      'session.latest',
      'session.messages',
      'session.modelChoice',
      'session.selectModel',
      'session.selectProfile',
      'workspace.pick',
      'workspace.remove',
      'workspace.usePrefill',
    ])
    expect([...EVENT_CHANNELS].toSorted()).toEqual([
      'chat.event',
      'chat.new',
      'chat.queue',
      'config.locale',
      'confirm.request',
      'mcp.changed',
      'run.state',
      'sandbox.changed',
    ])
    expect(new Set([...ROUTE_CHANNELS, ...EVENT_CHANNELS]).size).toBe(
      ROUTE_CHANNELS.length + EVENT_CHANNELS.length,
    )
  })

  it('rejects channels that are not declared', () => {
    expect(isRouteChannel('chat.send')).toBe(true)
    expect(isRouteChannel('fs.readFile')).toBe(false)
    expect(isEventChannel('chat.event')).toBe(true)
    expect(isEventChannel('chat.send')).toBe(false)
  })
})
