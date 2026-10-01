import { randomUUID } from 'node:crypto'
import {
  absolutePath,
  BUILTIN_SERVER_ID,
  anthropicDefinition,
  createMemoryHost,
  createMemoryTapeStore,
} from '@tenon-app/kernel'
import type { HostClock } from '@tenon-app/kernel'
import {
  createCounterIds,
  createTestLoopPorts,
  createTestSessionService,
} from '@tenon-app/kernel/testing'
import { officialProtocolTestNetwork } from '../../src/main/host/official-protocol-test-seam.js'
import type { OfficialWire } from './official-agent-evidence.js'

/** Real encoder/provider/loop; only the filesystem and policy snapshot are test inputs. */
export async function disabledToolEvidence(
  key: string,
  persist: (snapshot: Record<string, unknown>) => void,
) {
  const controller = new AbortController()
  const wire: OfficialWire[] = []
  const memory = createMemoryHost()
  const clock: HostClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  }
  const protocolStart = globalThis.tenonOfficialProtocolRecords?.length ?? 0
  const network = officialProtocolTestNetwork(
    {
      fetchUntrusted: memory.network.fetchUntrusted,
      fetch: async (input, init) => {
        const row: OfficialWire = {
          url: String(input),
          method: init?.method ?? 'GET',
          body:
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : null,
          status: null,
        }
        wire.push(row)
        controller.signal.throwIfAborted()
        const signal = init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        const response = await globalThis.fetch(input, { ...init, signal, redirect: 'error' })
        row.status = response.status
        return response
      },
    },
    false,
    { TENON_TEST_OFFICIAL_PROTOCOL: 'strict' },
  )
  const model = anthropicDefinition.builtinModels.find((row) => row.id === 'claude-opus-5-5')
  if (!model) throw new Error('Official Opus 5.5 model is absent')
  const provider = anthropicDefinition.create({
    network,
    clock,
    config: { baseURL: 'https://api.anthropic.com' },
    secrets: { apiKey: key },
  })
  const store = createMemoryTapeStore({
    identity: { userId: 'live', tenantId: 'live', profileDir: '/tenon/live' },
  })
  const loop = createTestLoopPorts({ connector: { provider, model, maxTokens: 4096 } })
  const service = createTestSessionService(
    {
      host: { ...memory, clock, network },
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    {
      tools: { Read: 'real' },
    },
  )
  service.bindLoop(loop)
  const sessionId = randomUUID()
  type End = Awaited<ReturnType<typeof loop.runEnded>>
  const runs: Promise<End>[] = []
  let firstEnd: End | undefined
  let secondEnd: End | undefined
  let firstCount = 0
  let failure: string | null = null
  let cleanupComplete = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = async () => {
    const dedicated = absolutePath(`/tenon/workspaces/live/live/${sessionId}`)
    const workspace = absolutePath('/work')
    await memory.fs.mkdirp(workspace)
    await memory.fs.writeFile(absolutePath('/work/code.txt'), 'LIVE_READ_VALUE_A')
    await service.selectProfile({ sessionId, profile: 'cowork', dedicated })
    await service.setWorkspace({
      sessionId,
      change: { kind: 'add', folders: [workspace] },
      dedicated,
    })
    const first = await service.send({
      sessionId,
      origin: null,
      text: 'Use Read exactly once on /work/code.txt. Reply its exact content and FIRST_DONE. Do not use any other tool.',
    })
    if (first.status !== 'started') throw new Error('First Read run did not start')
    const firstDone = loop.runEnded({ runId: first.runId })
    runs.push(firstDone)
    firstEnd = await firstDone
    controller.signal.throwIfAborted()
    firstCount = wire.length
    memory.setPolicy({
      status: 'current',
      version: 'live-disabled-read',
      snapshot: {
        tools: [
          {
            policyId: 'live-disabled-read',
            serverId: BUILTIN_SERVER_ID,
            toolName: 'Read',
            effect: 'deny',
          },
        ],
      },
    })
    await memory.fs.writeFile(absolutePath('/work/code.txt'), 'LIVE_READ_VALUE_B_MUST_NOT_BE_READ')
    controller.signal.throwIfAborted()
    const second = await service.send({
      sessionId,
      origin: null,
      text: 'The file /work/code.txt has changed. Use Read exactly once to get its new value. If the tool is blocked, report the denial and do not retry or use another tool. Finish SECOND_DONE.',
    })
    if (second.status !== 'started') throw new Error('Disabled Read run did not start')
    const secondDone = loop.runEnded({ runId: second.runId })
    runs.push(secondDone)
    secondEnd = await secondDone
  }
  let operation: Promise<void> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Official disabled-tool scenario exceeded 360 seconds'))
      }, 360_000)
    })
    operation = work()
    await Promise.race([operation, deadline])
  } catch (error) {
    // Provider error text may include arbitrary response data; only retain the error category.
    failure = controller.signal.aborted
      ? 'scenario-deadline'
      : error instanceof Error
        ? error.name
        : 'unknown-error'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const cleanup = async () => {
        await service.stop({ rootSessionId: sessionId })
        await Promise.allSettled([...runs, ...(operation ? [operation] : [])])
        cleanupComplete = true
      }
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('cleanup-deadline')), 15_000)
        }),
      ])
    } catch {
      failure ??= 'cleanup-did-not-settle'
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
      // Durable evidence is written even when send, provider, deadline or cleanup failed.
      const facts = (await store.readRange({ sessionId, limit: 1000 })).entries.map((entry) => ({
        name: entry.name,
        payload: entry.payload,
      }))
      persist({
        wire,
        protocol: (globalThis.tenonOfficialProtocolRecords ?? []).slice(protocolStart),
        firstCount,
        firstEnd,
        secondEnd,
        facts,
        failure,
        cleanupComplete,
      })
    }
  }
  const facts = (await store.readRange({ sessionId, limit: 1000 })).entries.map((entry) => ({
    name: entry.name,
    payload: entry.payload,
  }))
  return {
    wire,
    protocol: (globalThis.tenonOfficialProtocolRecords ?? []).slice(protocolStart),
    firstCount,
    firstEnd,
    secondEnd,
    facts,
    failure,
    cleanupComplete,
  }
}
