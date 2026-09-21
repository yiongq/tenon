import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, ROUTE_CHANNELS, isEventChannel, isRouteChannel } from '../src/registry.js'

describe('ipc registry', () => {
  it('lists every declared route and event exactly once', () => {
    expect([...ROUTE_CHANNELS].toSorted()).toEqual([
      'chat.send',
      'chat.stop',
      'config.get',
      'config.set',
      'provider.configure',
      'provider.list',
      'provider.select',
      'session.latest',
      'session.messages',
    ])
    expect([...EVENT_CHANNELS].toSorted()).toEqual([
      'chat.event',
      'chat.new',
      'config.locale',
      'confirm.request',
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
