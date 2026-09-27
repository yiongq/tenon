/**
 * A connector call's own fixed texts (spec 02 §工具来源、命名与权限键「elicitation 一律拒绝」,
 * §提示层「规则与位置」; plan step 18, 旧 224): a `callTool` that throws and a result with no content
 * both answer with a note from the prompt layer, so the version gate covers what they store.
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { McpConnection, McpToolSource } from '../../src/index.js'
import { MODEL_NOTES, fill } from '../../src/prompts/index.js'
import { mcpExecutor } from '../../src/tools/executor.js'
import type { ExecuteQuery } from '../../src/tools/executor.js'

function source(callTool: () => Promise<unknown>): McpToolSource {
  return { serverId: 'fs', connection: { callTool } as unknown as McpConnection }
}

function query(): ExecuteQuery {
  const host = createMemoryHost()
  return {
    item: {
      source: 'mcp',
      serverId: 'fs',
      originalName: 'look',
      name: 'fs__look',
      spec: { name: 'fs__look', description: '', inputSchema: { type: 'object' } },
      requiresUserInteraction: false,
    },
    input: {},
    signal: new AbortController().signal,
    target: null,
    scope: {
      roots: [],
      profileDir: absolutePath('/tenon/prof'),
      ownSpillDir: absolutePath('/tenon/prof/tool-output/s1'),
      protectedFiles: [],
    },
    fs: host.fs,
    clock: host.clock,
  }
}

/**
 * Runs `body` with one note of the layer swapped for `text`, as a later layer would write it: an
 * executor that takes the note from the layer follows it, and one with a literal of its own does not.
 */
async function withNote(
  key: 'connectorFailed' | 'connectorEmpty',
  text: string,
  body: () => Promise<void>,
): Promise<void> {
  const notes = MODEL_NOTES as {
    -readonly [K in keyof typeof MODEL_NOTES]: (typeof MODEL_NOTES)[K]
  }
  const before = notes[key]
  notes[key] = text
  try {
    await body()
  } finally {
    notes[key] = before
  }
}

describe('mcpExecutor’s fixed texts come from the prompt layer', () => {
  it('answers a callTool that throws with MODEL_NOTES.connectorFailed, as a call that ran', async () => {
    const run = mcpExecutor(source(() => Promise.reject(new Error('elicitation refused'))))
    expect(await run(query())).toEqual({
      content: [{ type: 'text', text: 'The tool call failed: elicitation refused' }],
      isError: true,
      state: 'completed',
    })
    await withNote('connectorFailed', 'Another layer: {message}', async () => {
      expect((await run(query())).content).toEqual([
        {
          type: 'text',
          text: fill(MODEL_NOTES.connectorFailed, { message: 'elicitation refused' }),
        },
      ])
    })
  })

  it('passes the connector’s own error flag through, only when it is true', async () => {
    const content = [{ type: 'text', text: 'no such file' }]
    const failed = mcpExecutor(source(() => Promise.resolve({ content, isError: true })))
    expect(await failed(query())).toEqual({ content, isError: true, state: 'completed' })
    const loose = mcpExecutor(source(() => Promise.resolve({ content, isError: 'true' })))
    expect((await loose(query())).isError).toBe(false)
  })

  it('answers a result with no content with MODEL_NOTES.connectorEmpty', async () => {
    const run = mcpExecutor(source(() => Promise.resolve({ content: [], isError: false })))
    expect(await run(query())).toEqual({
      content: [{ type: 'text', text: '(no output)' }],
      isError: false,
      state: 'completed',
    })
    await withNote('connectorEmpty', '(nothing came back)', async () => {
      expect((await run(query())).content).toEqual([{ type: 'text', text: '(nothing came back)' }])
    })
  })
})
