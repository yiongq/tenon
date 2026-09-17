import { describe, expect, it } from 'vitest'
import { confirmRequestSchema, requiredFactKeys } from '../src/ipc/confirm.js'

const base = { requestId: 'r1', sessionId: 's1' }

describe('confirmRequestSchema', () => {
  it('accepts a request whose facts fill every required slot', () => {
    const parsed = confirmRequestSchema.safeParse({
      ...base,
      kind: 'network',
      reason: 'network',
      facts: { host: 'api.example.com', toolName: 'fetch' },
    })
    expect(parsed.success).toBe(true)
  })

  it('names the missing slot when a required fact is absent', () => {
    const parsed = confirmRequestSchema.safeParse({
      ...base,
      kind: 'tool',
      reason: 'outside-workspace',
      facts: { path: '/etc/hosts' },
    })
    expect(parsed.success).toBe(false)
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
    expect(paths).toEqual(['facts.workspace'])
  })

  it('treats an empty string as an unfilled slot', () => {
    const parsed = confirmRequestSchema.safeParse({
      ...base,
      kind: 'tool',
      reason: 'default',
      facts: { toolName: '' },
    })
    expect(parsed.success).toBe(false)
  })

  it('requires path / command for irreversible file / command requests', () => {
    expect(requiredFactKeys('irreversible', 'tool')).toEqual(['toolName'])
    expect(requiredFactKeys('irreversible', 'file')).toEqual(['toolName', 'path'])
    expect(requiredFactKeys('irreversible', 'command')).toEqual(['toolName', 'command'])
    const file = confirmRequestSchema.safeParse({
      ...base,
      kind: 'file',
      reason: 'irreversible',
      facts: { toolName: 'delete' },
    })
    expect(file.success).toBe(false)
    const command = confirmRequestSchema.safeParse({
      ...base,
      kind: 'command',
      reason: 'irreversible',
      facts: { toolName: 'bash', command: 'rm -rf build' },
    })
    expect(command.success).toBe(true)
  })

  it('rejects unknown reasons and kinds', () => {
    expect(
      confirmRequestSchema.safeParse({ ...base, kind: 'tool', reason: 'scary', facts: {} }).success,
    ).toBe(false)
    expect(
      confirmRequestSchema.safeParse({ ...base, kind: 'gpu', reason: 'default', facts: {} })
        .success,
    ).toBe(false)
  })
})
