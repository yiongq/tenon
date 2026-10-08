import type { McpServerView } from '@tenon-app/contracts'
export function serverView(patch: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 'notes',
    displayName: 'Notes',
    source: 'manual',
    enabled: true,
    transport: { type: 'stdio', command: '/usr/bin/node', args: [], envs: {}, env_keys: [] },
    handshakeTimeoutSec: null,
    callTimeoutSec: null,
    instructions: { enabled: false, pinHash: null },
    consent: null,
    toolsPinned: true,
    tools: {},
    status: {
      serverId: 'notes',
      phase: 'connected',
      stopReason: null,
      error: null,
      firstConnect: false,
      restartInMs: null,
      era: 'modern',
      protocolVersion: '2026-07-28',
    },
    toolViews: [],
    instructionsView: null,
    needsConsent: false,
    loggedIn: null,
    ...patch,
  }
}
