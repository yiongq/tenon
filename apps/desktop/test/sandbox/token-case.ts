/** S-only regression: run through the kernel so Tape and tool results are real observations. */
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import { expect } from 'vitest'
import { createHostProcess } from '../../src/main/host/process.js'
import { SystemClock } from '../../src/main/host/clock.js'
import { SHELL, type SandboxRig } from './support.js'

export async function tokenRegression(rig: SandboxRig): Promise<void> {
  const lab = rig.lab()
  const work = absolutePath(lab.dir('ws'))
  lab.folders = [work]
  const memory = createMemoryHost()
  await memory.fs.mkdirp(work)
  const logs: string[] = []
  const errors: string[] = []
  const wrapped: string[] = []
  const process = createHostProcess((line) => logs.push(line))
  let spawns = 0
  const host = {
    ...memory,
    identity: { ...memory.identity, profileDir: lab.profileDir },
    clock: new SystemClock(),
    sandbox: lab.sandbox,
    process: {
      spawn: async (spec: Parameters<typeof process.spawn>[0]) => {
        spawns += 1
        try {
          // A real ENOENT after a successful second wrap, as Bash must clean up after too.
          return await process.spawn(
            spawns === 2
              ? { ...spec, argv: [`${lab.home}/missing-executable`, ...spec.argv.slice(1)] }
              : spec,
          )
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
          throw error
        }
      },
    },
  }
  const model = {
    id: 'sandbox-token-test',
    providerId: 'anthropic',
    contextLimit: 200_000,
    maxOutputTokens: 1024,
    reasoning: false,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop' as const,
    usageNeedsOptIn: false,
  }
  const provider = createScriptedProvider({ models: [model] })
  const loop = createTestLoopPorts({ connector: { provider, model } })
  const store = createMemoryTapeStore({ identity: host.identity })
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      protectedFiles: [],
      connector: loop.connector,
      log: (line) => logs.push(line),
    },
    { tools: { Bash: 'real' } },
  )
  service.bindLoop({
    ...loop,
    commandShell: { path: absolutePath(SHELL), env: async () => lab.requestEnv() },
    sandbox: {
      beforeWrap: (q) => {
        wrapped.push(q.commandId)
        lab.sandbox.beforeWrap(q)
      },
      grantsChanged: () => {},
    },
  })
  const sessionId = lab.sessionId
  await service.selectProfile({ sessionId, profile: 'cowork', dedicated: work })
  await service.setWorkspace({
    sessionId,
    change: { kind: 'add', folders: [work] },
    dedicated: work,
  })
  const runCommand = async (id: string): Promise<void> => {
    provider.script([
      { type: 'tool-call-start', index: 1, id, name: 'Bash' },
      {
        type: 'tool-call-end',
        index: 1,
        id,
        name: 'Bash',
        input: {
          command: id === 'token-success' ? 'printf token-case-ok' : 'printf token-case-failure',
        },
      },
      stopEvent('tool-use', 'tool_use'),
    ])
    const sent = await service.send({ sessionId, text: id, origin: null })
    expect(sent.status).toBe('started')
    if (sent.status !== 'started') throw new Error('token case did not start')
    await loop.runEnded({ runId: sent.runId })
    const pending = await service.currentPending({ sessionId })
    if (pending?.waitKind !== 'approval') throw new Error('token case did not reach approval')
    provider.script(scriptedTurn({ deltas: ['Done.'] }))
    await service.answer({
      kind: 'approval',
      sessionId,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    })
    await loop.runEnded()
  }
  await runCommand('token-success')
  await runCommand('token-spawn-failure')
  const entries = (await store.readRange({ sessionId, limit: 1000 })).entries
  const results = entries.filter((entry) => entry.name === 'tool/result')
  const token = SandboxManager.getProxyAuthToken()
  // Boolean assertions prevent a failing assertion from printing the actual token or argv.
  expect(typeof token === 'string' && token.length > 0).toBe(true)
  if (!token) throw new Error('srt did not expose its proxy token')
  const artifacts = [
    ...rig.logs,
    ...logs,
    ...errors,
    ...entries.map((entry) => JSON.stringify(entry)),
    ...results.map((entry) => JSON.stringify(entry.payload)),
  ]
  expect(artifacts.some((text) => text.includes(token))).toBe(false)
  expect(spawns).toBe(2)
  expect(wrapped).toHaveLength(2)
  expect(results).toHaveLength(2)
  expect(JSON.stringify(results[0]?.payload).includes('token-case-ok')).toBe(true)
  expect(JSON.stringify(results[1]?.payload).includes('ENOENT')).toBe(true)
  expect(errors).toHaveLength(1)
}
