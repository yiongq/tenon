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

it('03: unavailable and unauthorized close not-run with their source; stop closes uncertain', async () => {
  const { McpServerUnavailableError, McpUnauthorizedError } =
    await import('../../src/mcp/connection.js')
  for (const [error, expected] of [
    [new McpServerUnavailableError(), 'tool-unavailable'],
    [new McpUnauthorizedError(), 'connector-unauthorized'],
  ] as const) {
    expect(
      // oxlint-disable-next-line no-await-in-loop
      await mcpExecutor(
        source(async () => {
          throw error
        }),
      )(query()),
    ).toMatchObject({ state: 'not-run', source: expected, kernelAuthored: true, isError: true })
  }
  const stop = new AbortController()
  stop.abort()
  expect(
    await mcpExecutor(
      source(async () => {
        throw new Error('stop')
      }),
    )({ ...query(), signal: stop.signal }),
  ).toMatchObject({ state: 'uncertain', content: [], isError: true })
})

it('03 验收 30 (executor): the live stop signal reaches the connection; timeouts remain completed', async () => {
  const stop = new AbortController()
  let forwarded!: AbortSignal
  const connection = {
    callTool: async (_name: string, _args: unknown, options: { signal: AbortSignal }) => {
      forwarded = options.signal
      return new Promise((_resolve, reject) => {
        forwarded.addEventListener('abort', () => reject(forwarded.reason), { once: true })
      })
    },
  } as unknown as McpConnection
  const pending = mcpExecutor({ serverId: 'fs', connection })({ ...query(), signal: stop.signal })
  expect(forwarded).toBe(stop.signal)
  stop.abort(new Error('stop'))
  expect(await pending).toMatchObject({ state: 'uncertain', content: [], isError: true })
  expect(
    await mcpExecutor(
      source(async () => {
        throw new Error('MCP total time limit exceeded')
      }),
    )(query()),
  ).toMatchObject({ state: 'completed', isError: true })
})
