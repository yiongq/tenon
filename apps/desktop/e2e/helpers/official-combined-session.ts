/** Plan 33 old 65: one persistent root session, real providers and real file executors. */
import { randomUUID } from 'node:crypto'
import {
  absolutePath,
  BUILTIN_SERVER_ID,
  anthropicDefinition,
  zhipuDefinition,
  createMemoryHost,
  createMemoryTapeStore,
} from '@tenon-app/kernel'
import type { HostClock } from '@tenon-app/kernel'
import { createTestLoopPorts, createTestSessionService } from '@tenon-app/kernel/testing'
import { officialProtocolTestNetwork } from '../../src/main/host/official-protocol-test-seam.js'
import { strictAccepted } from './official-agent-evidence.js'
import type { OfficialWire } from './official-agent-evidence.js'

const OFFICIAL = 'https://api.anthropic.com/v1/messages'
const OPUS = 'claude-opus-5-5'
const ZHIPU = 'glm-5.3-flash'
class ScenarioAssertion extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'ScenarioAssertion'
  }
}
function requireFact(ok: unknown, label: string): asserts ok {
  if (!ok) throw new ScenarioAssertion(label)
}

/** Caller owns credentials and evidence path; this helper never logs either credential. */
export async function combinedSessionEvidence(
  keys: { anthropic: string; zhipu: string },
  persist: (snapshot: Record<string, unknown>) => void,
) {
  const controller = new AbortController()
  const memory = createMemoryHost()
  const sessionId = randomUUID()
  const wire: OfficialWire[] = []
  const stages: Array<{ name: string; requests: number; entryId: number }> = []
  const protocolStart = globalThis.tenonOfficialProtocolRecords?.length ?? 0
  const clock: HostClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  }
  const network = officialProtocolTestNetwork(
    {
      fetchUntrusted: memory.network.fetchUntrusted,
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        requireFact(
          url === OFFICIAL || url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          'unexpected-protocol-host',
        )
        const row: OfficialWire = {
          url,
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
  const opus = anthropicDefinition.builtinModels.find((row) => row.id === OPUS)
  const zhipu = zhipuDefinition.builtinModels.find((row) => row.id === ZHIPU)
  requireFact(opus && zhipu, 'required-model-missing')
  const officialProvider = anthropicDefinition.create({
    network,
    clock,
    config: { baseURL: 'https://api.anthropic.com' },
    secrets: { apiKey: keys.anthropic },
  })
  const zhipuProvider = zhipuDefinition.create({
    network,
    clock,
    config: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    secrets: { apiKey: keys.zhipu },
  })
  const store = createMemoryTapeStore({ identity: memory.identity })
  let loop = createTestLoopPorts({
    connector: { provider: officialProvider, model: opus, maxTokens: 4096 },
  })
  const newService = (threshold?: number) => {
    const result = createTestSessionService(
      {
        host: { ...memory, clock, network },
        tape: store,
        ids: { uuid: randomUUID },
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
        ...(threshold === undefined ? {} : { compactionThreshold: threshold }),
      },
      {
        tools: {
          Read: 'real',
          Write: 'real',
          Glob: 'real',
          Grep: null,
          Edit: null,
          Bash: null,
          Agent: null,
          AskUserQuestion: null,
          WebFetch: null,
          WebSearch: null,
        },
      },
    )
    result.bindLoop(loop)
    return result
  }
  let service = newService()
  const runs: Array<Promise<unknown>> = []
  const facts = async () => (await store.readRange({ sessionId, limit: 1000 })).entries
  const checkpoint = async (name: string) => {
    const entries = await facts()
    stages.push({ name, requests: wire.length, entryId: entries.at(-1)?.entryId ?? 0 })
    persist(snapshot(entries))
  }
  let failure: string | null = null
  let cleanupComplete = false
  let stage = 'setup'
  function snapshot(entries: Awaited<ReturnType<typeof facts>>) {
    return {
      date: new Date().toISOString(),
      model: OPUS,
      host: OFFICIAL,
      sessionId,
      stage,
      wire,
      protocol: (globalThis.tenonOfficialProtocolRecords ?? []).slice(protocolStart),
      stages,
      facts: entries.map((e) => ({
        name: e.name,
        sourceId: e.sourceId,
        sourceSeq: e.sourceSeq,
        entryId: e.entryId,
        payload: e.payload,
      })),
      failure,
      cleanupComplete,
    }
  }
  const waitEnd = (runId?: string) => {
    const done = loop.runEnded(runId === undefined ? undefined : { runId })
    runs.push(done)
    return done
  }
  const send = async (text: string, paused = false, allowRefusal = false) => {
    controller.signal.throwIfAborted()
    const start = await service.send({ sessionId, origin: null, text })
    requireFact(start.status === 'started', 'run-not-started')
    const end = await waitEnd(start.runId)
    requireFact(
      end.reason.code === (paused ? 'paused' : 'completed') ||
        (allowRefusal && end.reason.code === 'refusal'),
      'unexpected-run-end',
    )
    controller.signal.throwIfAborted()
  }
  const work = async () => {
    const dedicated = absolutePath(`/work/${sessionId}`)
    await memory.fs.mkdirp(dedicated)
    const path = absolutePath(`${dedicated}/code.txt`)
    await memory.fs.writeFile(path, 'COMBINED_READ_VALUE_A')
    await service.selectProfile({ sessionId, profile: 'cowork', dedicated })
    stage = 'initial-read'
    await send(
      `Use Read exactly once on ${path}. Reply its exact contents and READ_DONE. No other tools.`,
    )
    requireFact(
      (await facts()).some(
        (e) =>
          e.name === 'tool/result' &&
          e.payload['isError'] === false &&
          JSON.stringify(e.payload['content']).includes('COMBINED_READ_VALUE_A'),
      ),
      'read-not-recorded',
    )
    const originalTools = wire.find((row) => row.url === OFFICIAL)?.body?.['tools']
    requireFact(Array.isArray(originalTools) && originalTools.length > 0, 'initial-tools-missing')
    await checkpoint(stage)

    stage = 'disable-read'
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
    await memory.fs.writeFile(path, 'COMBINED_READ_VALUE_B_MUST_STAY_UNREAD')
    await send(
      `The file ${path} changed. Call Read exactly once. If denied, report the denial without retrying or using any other tool. Finish BLOCKED_DONE.`,
      false,
      true,
    )
    const blocked = await facts()
    requireFact(
      blocked.some((e) => e.name === 'execution/tool_outcome' && e.payload['source'] === 'policy'),
      'disabled-read-not-observed',
    )
    requireFact(
      !JSON.stringify(blocked.filter((e) => e.name === 'tool/result')).includes(
        'COMBINED_READ_VALUE_B_MUST_STAY_UNREAD',
      ),
      'disabled-read-leaked',
    )
    const deniedCalls = blocked.filter(
      (e) => e.name === 'execution/tool_outcome' && e.payload['source'] === 'policy',
    )
    requireFact(
      deniedCalls.every(
        (denied) =>
          denied.payload['state'] === 'not-run' &&
          !blocked.some(
            (e) =>
              e.name === 'execution/dispatch_committed' &&
              e.payload['providerToolCallId'] === denied.payload['providerToolCallId'],
          ),
      ),
      'disabled-read-was-dispatched',
    )
    await checkpoint(stage)

    stage = 'write-approval'
    const target = absolutePath(`${dedicated}/approved.txt`)
    await send(
      `Use Write exactly once to create ${target} containing COMBINED_APPROVED. Then reply WRITE_DONE. Do not use other tools.`,
      true,
    )
    const pending = await service.currentPending({ sessionId })
    requireFact(
      pending?.waitKind === 'approval' && pending.card.kind === 'file',
      'write-card-missing',
    )
    const beforeAnswer = await facts()
    requireFact(
      beforeAnswer.some(
        (e) =>
          e.name === 'tool/call' &&
          `${e.sourceId}:${e.sourceSeq}:${String(e.payload['ordinal'])}` === pending.callKey &&
          e.payload['name'] === 'Write' &&
          (e.payload['input'] as { file_path?: string }).file_path === target,
      ),
      'approval-is-not-target-write',
    )
    const pausedRun = beforeAnswer.findLast((e) => e.name === 'execution/run_terminal')?.sourceId
    const answer = await service.answer({
      kind: 'approval',
      sessionId,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    })
    requireFact(answer.status === 'applied', 'write-answer-not-applied')
    requireFact((await waitEnd()).reason.code === 'completed', 'approved-run-not-completed')
    const resumedFacts = await facts()
    requireFact(
      resumedFacts.some(
        (e) =>
          e.name === 'execution/run_started' &&
          e.sourceId !== pausedRun &&
          (e.payload['cause'] as { kind?: string; pausedRunId?: string }).kind === 'resume' &&
          (e.payload['cause'] as { pausedRunId?: string }).pausedRunId === pausedRun,
      ),
      'cross-run-approval-not-proved',
    )
    const written = await memory.fs.readFile(target)
    requireFact(
      (typeof written === 'string' ? written : new TextDecoder().decode(written)) ===
        'COMBINED_APPROVED',
      'write-did-not-execute',
    )
    await checkpoint(stage)

    stage = 'zhipu-tool'
    loop.connector.use({ provider: zhipuProvider, model: zhipu, maxTokens: 4096 })
    await service.selectModel({
      sessionId,
      origin: null,
      choice: { providerId: 'zhipu', modelId: zhipu.id, effort: null },
    })
    const beforeZhipu = (await facts()).at(-1)?.entryId ?? 0
    await send(
      `Use Glob exactly once with pattern *.txt and path ${dedicated}. Reply the filenames and ZHIPU_DONE. Do not call Read or other tools.`,
    )
    const zhipuFacts = (await facts()).filter((e) => e.entryId > beforeZhipu)
    const generated = zhipuFacts.filter(
      (e) => e.name === 'tool/call' && e.payload['name'] === 'Glob',
    )
    requireFact(generated.length === 1, 'zhipu-glob-call-missing')
    const toolId = String(generated[0]!.payload['providerToolCallId'])
    requireFact(
      zhipuFacts.some(
        (e) =>
          e.name === 'execution/dispatch_committed' && e.payload['providerToolCallId'] === toolId,
      ),
      'zhipu-glob-not-dispatched',
    )
    requireFact(
      zhipuFacts.some(
        (e) =>
          e.name === 'tool/result' &&
          e.payload['providerToolCallId'] === toolId &&
          e.payload['isError'] === false &&
          JSON.stringify(e.payload['content']).includes('approved.txt') &&
          JSON.stringify(e.payload['content']).includes('code.txt'),
      ),
      'zhipu-glob-not-successful',
    )
    await checkpoint(stage)

    stage = 'anthropic-return-before-compaction'
    loop.connector.use({ provider: officialProvider, model: opus, maxTokens: 4096 })
    await service.selectModel({
      sessionId,
      origin: null,
      choice: { providerId: 'anthropic', modelId: opus.id, effort: null },
    })
    const beforeReturn = wire.length
    await send('Reply RETURN_DONE only. Do not call any tools.')
    const returned = wire.slice(beforeReturn).filter((row) => row.url === OFFICIAL)
    requireFact(returned.length > 0, 'official-return-missing')
    const blocks = returned.flatMap((row) => {
      const messages = row.body?.['messages'] as Array<{ content?: unknown }> | undefined
      return (messages ?? []).flatMap((message) =>
        Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
      )
    })
    requireFact(
      blocks.some((block) => block['type'] === 'tool_use' && block['id'] === toolId),
      'zhipu-id-not-replayed-to-official',
    )
    requireFact(
      blocks.some((block) => block['type'] === 'tool_result' && block['tool_use_id'] === toolId),
      'zhipu-result-not-replayed-to-official',
    )
    requireFact(
      !(await facts()).some((e) => e.name === 'compaction/anchor'),
      'compacted-before-cross-provider-proof',
    )
    requireFact(
      wire
        .filter((row) => row.url === OFFICIAL)
        .every((row) => JSON.stringify(row.body?.['tools']) === JSON.stringify(originalTools)),
      'frozen-tools-changed',
    )
    await checkpoint(stage)

    stage = 'same-session-compaction'
    requireFact(loop.liveLease(sessionId) === null, 'lease-active-before-reopen')
    loop = createTestLoopPorts({
      connector: { provider: officialProvider, model: opus, maxTokens: 4096 },
    })
    service = newService(1)
    await service.recover()
    const beforeCompact = wire.length
    await send('Reply COMPACTION_DONE only. Do not call tools.')
    const compacted = await facts()
    requireFact(
      compacted.filter((e) => e.name === 'session/start').length === 1,
      'session-recreated',
    )
    requireFact(
      compacted.filter((e) => e.name === 'compaction/anchor').length === 1,
      'compaction-anchor-missing',
    )
    requireFact(
      compacted.filter(
        (e) => e.name === 'provider/attempt_completed' && e.payload['compaction'] !== undefined,
      ).length === 1,
      'summary-attempt-missing',
    )
    const compactWire = wire
      .slice(beforeCompact)
      .filter((row) => row.url === OFFICIAL && row.status !== null)
    requireFact(
      compactWire.length === 2 && compactWire[0]?.body?.['tools'] === undefined,
      'summary-main-wire-mismatch',
    )
    requireFact(
      wire.filter((row) => row.status !== null).every((row) => row.status === 200),
      'wire-not-200',
    )
    const failedConnections = wire.filter((row) => row.status === null)
    const recordedNetworkFailures = compacted.filter(
      (e) =>
        e.name === 'provider/attempt_completed' &&
        (e.payload['error'] as { code?: string } | null)?.code === 'network',
    )
    requireFact(
      failedConnections.length === recordedNetworkFailures.length,
      'unexplained-wire-failure',
    )
    requireFact(
      failedConnections.every((row) =>
        wire
          .slice(wire.indexOf(row) + 1)
          .some(
            (retry) =>
              retry.status === 200 &&
              retry.url === row.url &&
              JSON.stringify(retry.body) === JSON.stringify(row.body),
          ),
      ),
      'network-retry-did-not-preserve-request',
    )
    const protocol = (globalThis.tenonOfficialProtocolRecords ?? []).slice(protocolStart)
    requireFact(
      protocol.length === wire.filter((row) => row.url === OFFICIAL).length,
      'missing-protocol-evidence',
    )
    requireFact(
      strictAccepted(protocol.filter((record) => record.status !== null)),
      'strict-prefix-not-proved',
    )
    await checkpoint(stage)
  }
  let operation: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('scenario-deadline'))
      }, 900_000)
    })
    operation = work()
    await Promise.race([operation, deadline])
  } catch (error) {
    // Only our stage and error category; never upstream response text or credentials.
    failure = controller.signal.aborted
      ? 'scenario-deadline'
      : error instanceof ScenarioAssertion
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown-error'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          await service.stop({ rootSessionId: sessionId })
          await Promise.allSettled([...runs, ...(operation ? [operation] : [])])
          cleanupComplete = true
        })(),
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('cleanup-deadline')), 15_000)
        }),
      ])
    } catch {
      failure ??= 'cleanup-did-not-settle'
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
      persist(snapshot(await facts()))
    }
  }
  return snapshot(await facts())
}
