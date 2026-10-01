/**
 * Spec 02 acceptance 54 / step 33, raw official protocol preparation.
 * The live config includes live-* specs and the default suite excludes them; execution also
 * requires both TENON_LIVE and TENON_LIVE_OFFICIAL_PROTOCOL. No account probe is repeated here.
 * `TENON_LIVE_OFFICIAL_PROTOCOL=1` is an additional explicit opt-in. Fable also requires
 * `TENON_LIVE_FABLE_30_DAY_RETENTION=1` after the operator has configured the organization.
 * Strict requests use the already-classified old-account binding controls. Shape-only requests
 * deliberately preserve the exact production shape and are NOT evidence of strict prefix binding.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { anthropicDefinition, createMemoryHost, decideThinking } from '@tenon-app/kernel'
import type { ProviderRequest } from '@tenon-app/kernel'
import { MODEL_NOTES } from '../../../packages/kernel/src/prompts/index.js'
import {
  PLAIN_TEXT_FRAMES,
  THINKING_FRAMES,
  ONE_TOOL_CALL_FRAMES,
} from '../../../packages/kernel/test/provider/fixtures/anthropic-sse.js'
import { captureOfficialSse, replayOfficialSse } from './helpers/official-sse-replay.js'
import { officialGroup } from './helpers/live-env.js'
import { test, expect } from './helpers/test.js'

const enabled =
  process.env['TENON_LIVE'] === '1' && process.env['TENON_LIVE_OFFICIAL_PROTOCOL'] === '1'
const envFile = resolve(process.cwd(), '../../.env.local')
const fromFile = enabled && existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
const pick = (...names: string[]) =>
  names.map((name) => process.env[name] || fromFile[name]).find(Boolean)
const group = enabled
  ? officialGroup(process.env, fromFile, pick, '4096')
  : { kind: 'absent' as const, reason: 'explicit official protocol opt-in required' }
const endpoint = 'https://api.anthropic.com/v1/messages'
type Block = { type: string; [key: string]: unknown }
type Message = { role: 'user' | 'assistant'; content: string | Block[] }
type Body = Record<string, unknown> & { model: string; messages: Message[] }
type Answer = {
  content: Block[]
  stop: string | null
  usage: Record<string, unknown>
  transformations: unknown[]
  pingAtMs: number[]
  complete: boolean
  partialTools: number
}
type RecordRow = Record<string, unknown>
let rows: RecordRow[] = []
let scenarioController = new AbortController()
let scenarioTimer: ReturnType<typeof setTimeout> | undefined
const inFlight = new Set<Promise<Answer>>()

const tool = {
  name: 'lookup',
  description: 'Return a public fixture value. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: { total: { type: 'integer' }, odd: { type: 'integer' } },
    required: ['total', 'odd'],
    additionalProperties: false,
  },
}
const task =
  'Count positive integers below 500 with exactly six positive divisors, and how many are odd. Call lookup once with total and odd. After its result, answer DONE only.'
const base = (model: string, messages: Message[]): Body => ({
  model,
  messages,
  max_tokens: 4096,
  stream: false,
  system: 'You are a protocol test assistant. Follow the task briefly.',
})

/** No request headers or credentials enter records. Explicit SSE capture stores synthetic replies. */
function request(label: string, body: Body, strict: boolean): Promise<Answer> {
  const operation = requestOnce(label, body, strict)
  inFlight.add(operation)
  // Both handlers consume only bookkeeping; the original rejection still reaches the caller.
  void operation.then(
    () => {
      inFlight.delete(operation)
    },
    () => {
      inFlight.delete(operation)
    },
  )
  return operation
}

async function requestOnce(label: string, body: Body, strict: boolean): Promise<Answer> {
  scenarioController.signal.throwIfAborted()
  if (group.kind !== 'ready') throw new Error('Official protocol credentials refused or absent')
  const actual = strict
    ? {
        ...body,
        thinking: {
          type: 'adaptive',
          ...(typeof body['thinking'] === 'object' ? body['thinking'] : {}),
          block_binding: { prefix_mismatch_behavior: 'error' },
        },
      }
    : body
  const row: RecordRow = {
    label,
    date: new Date().toISOString(),
    host: 'api.anthropic.com',
    model: body.model,
    strict,
    thinking: actual['thinking'] ?? null,
    stream: actual['stream'],
    requestBody: actual,
    effort: actual['output_config'] ?? null,
    maxTokens: actual['max_tokens'],
    cacheControl: actual['cache_control'] ?? null,
    toolsPresent: Array.isArray(actual['tools']),
  }
  rows.push(row)
  const capture =
    process.env['TENON_LIVE_CAPTURE_SSE'] === '1' && actual['stream'] === true
      ? captureOfficialSse()
      : undefined
  let replayFailure: unknown
  const answer: Answer = {
    content: [],
    stop: null,
    usage: {},
    transformations: [],
    pingAtMs: [],
    complete: false,
    partialTools: 0,
  }
  const redact = (value: unknown) =>
    String(value ?? '')
      .replaceAll(group.env['ANTHROPIC_API_KEY'] ?? '', '[redacted]')
      .slice(0, 2000)
  try {
    const started = performance.now()
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(180_000), scenarioController.signal]),
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': group.env['ANTHROPIC_API_KEY'] ?? '',
        ...(strict ? { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' } : {}),
      },
      body: JSON.stringify(actual),
    })
    row['status'] = response.status
    row['requestId'] = response.headers.get('request-id')
    const transformations = (value: unknown) => {
      if (value !== null && typeof value === 'object' && 'input_transformations' in value)
        answer.transformations.push(value.input_transformations)
    }
    if (!response.ok || actual['stream'] !== true) {
      const result = (await response.json()) as Record<string, unknown>
      transformations(result)
      answer.content = (result['content'] ?? []) as Block[]
      answer.stop = typeof result['stop_reason'] === 'string' ? result['stop_reason'] : null
      answer.usage = (result['usage'] ?? {}) as Record<string, unknown>
      answer.complete = response.ok
      const error = result['error'] as { type?: string; message?: string } | undefined
      row['errorType'] = error?.type ?? null
      if (error?.message !== undefined) row['errorMessage'] = redact(error.message)
    } else {
      if (response.body === null) throw new Error('Official SSE response has no body')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const blocks = new Map<number, Block>()
      const partial = new Map<number, string>()
      let pending = ''
      const frame = (text: string) => {
        const data = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '') return
        const event = JSON.parse(data) as Record<string, unknown>
        transformations(event)
        transformations(event['message'])
        transformations(event['delta'])
        const index = Number(event['index'])
        if (event['type'] === 'ping') answer.pingAtMs.push(performance.now() - started)
        if (event['type'] === 'message_start')
          answer.usage = {
            ...((event['message'] as Record<string, unknown>)['usage'] as Record<string, unknown>),
          }
        if (event['type'] === 'content_block_start')
          blocks.set(index, { ...(event['content_block'] as Block) })
        if (event['type'] === 'content_block_delta') {
          const delta = event['delta'] as Record<string, unknown>
          const block = blocks.get(index)
          if (block === undefined) throw new Error('SSE delta without block start')
          if (delta['type'] === 'input_json_delta')
            partial.set(index, (partial.get(index) ?? '') + String(delta['partial_json']))
          for (const key of ['text', 'thinking', 'signature'])
            if (typeof delta[key] === 'string') block[key] = String(block[key] ?? '') + delta[key]
        }
        if (event['type'] === 'content_block_stop') {
          const block = blocks.get(index)
          if (block === undefined) throw new Error('SSE stop without block start')
          const json = partial.get(index)
          if (json !== undefined) {
            try {
              block['input'] = JSON.parse(json) as unknown
            } catch {
              answer.partialTools += 1
              blocks.delete(index)
              return
            }
          }
          answer.content.push(block)
          blocks.delete(index)
        }
        if (event['type'] === 'message_delta') {
          answer.stop = String((event['delta'] as Record<string, unknown>)['stop_reason'])
          answer.usage = { ...answer.usage, ...(event['usage'] as Record<string, unknown>) }
        }
        if (event['type'] === 'message_stop') answer.complete = true
        if (event['type'] === 'error') {
          const error = event['error'] as { type?: string; message?: string } | undefined
          row['errorType'] = error?.type ?? 'sse-error'
          row['errorMessage'] = redact(error?.message)
          throw new Error('Official SSE error event')
        }
      }
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- preserve the real SSE order and ping timing
          const chunk = await reader.read()
          if (chunk.value !== undefined) capture?.feed(chunk.value, performance.now() - started)
          pending += decoder.decode(chunk.value, { stream: !chunk.done })
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(pending)
            if (boundary === null) break
            frame(pending.slice(0, boundary.index))
            pending = pending.slice(boundary.index + boundary[0].length)
          }
          if (chunk.done) break
        }
        answer.partialTools += [...blocks.values()].filter(
          (block) => block.type === 'tool_use',
        ).length
      } finally {
        if (!answer.complete) await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    }
    expect(response.status).toBe(200)
    expect(answer.complete).toBe(true)
    if (strict) {
      expect(
        answer.transformations.length,
        'actual field required; missing is not []',
      ).toBeGreaterThan(0)
      for (const value of answer.transformations) expect(value).toEqual([])
    }
  } catch (error) {
    row['failure'] = redact(error instanceof Error ? error.message : error)
    throw error
  } finally {
    Object.assign(row, {
      stop: answer.stop,
      usage: answer.usage,
      transformations: answer.transformations,
      pingAtMs: answer.pingAtMs,
      complete: answer.complete,
      partialTools: answer.partialTools,
      blocks: answer.content.map((block) => ({
        type: block.type,
        signed: typeof block['signature'] === 'string' && block['signature'].length > 0,
        emptyThinking: block.type === 'thinking' ? block['thinking'] === '' : undefined,
      })),
    })
    if (capture !== undefined) {
      const captured = capture.finish()
      const directory = pick('TENON_LIVE_RECORD_DIR') ?? test.info().outputDir
      mkdirSync(directory, { recursive: true })
      const stem = join(directory, `sse-${label}-${randomUUID()}`)
      writeFileSync(
        `${stem}.sse`,
        captured.frames.map((frame) => frame.raw).join('') + captured.tail,
      )
      writeFileSync(`${stem}.capture.json`, JSON.stringify(captured, null, 2))
      row['sseCapture'] = `${stem}.sse`
      if (answer.complete && answer.partialTools === 0 && captured.frames.length > 0) {
        try {
          const replay = await replayOfficialSse(captured, {
            PLAIN_TEXT_FRAMES,
            THINKING_FRAMES,
            ONE_TOOL_CALL_FRAMES,
          })
          writeFileSync(`${stem}.replay.json`, JSON.stringify(replay, null, 2))
          row['sseReplay'] = `${stem}.replay.json`
        } catch (error) {
          row['sseReplayFailure'] = redact(error instanceof Error ? error.message : error)
          replayFailure = error
        }
      }
    }
  }
  if (replayFailure !== undefined) throw replayFailure
  return answer
}

function resultMessages(messages: Message[], answer: Answer): Message[] {
  const calls = answer.content.filter((block) => block.type === 'tool_use')
  expect(answer.stop).toBe('tool_use')
  expect(calls).toHaveLength(1)
  return [
    ...messages,
    { role: 'assistant', content: answer.content },
    {
      role: 'user',
      content: calls.map((call) => ({
        type: 'tool_result',
        tool_use_id: call['id'],
        content: 'PUBLIC_FIXTURE_VALUE',
      })),
    },
  ]
}

test.describe('live raw protocol · anthropic official · step 33 preparation', () => {
  test.describe.configure({ timeout: 600_000 })
  test.skip(group.kind === 'absent', group.kind === 'absent' ? group.reason : '')
  test.beforeEach(() => {
    rows = []
    scenarioController = new AbortController()
    scenarioTimer = setTimeout(() => {
      scenarioController.abort(new Error('Official protocol scenario exceeded 540 seconds'))
    }, 540_000)
  })
  test.afterEach(async () => {
    if (scenarioTimer !== undefined) clearTimeout(scenarioTimer)
    scenarioTimer = undefined
    scenarioController.abort()
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    let cleanupComplete = false
    try {
      // requestOnce.finally publishes partial usage/SSE evidence before its promise settles.
      await Promise.race([
        Promise.allSettled(inFlight).then(() => {
          cleanupComplete = true
        }),
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('request-cleanup-deadline')), 15_000)
        }),
      ])
    } catch {
      rows.push({ label: 'cleanup', failure: 'request-cleanup-deadline', inFlight: inFlight.size })
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
    }
    const info = test.info()
    const directory = pick('TENON_LIVE_RECORD_DIR')
    const name = `official-protocol-${info.testId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
    const destination = directory === undefined ? info.outputPath(name) : join(directory, name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, JSON.stringify(rows, null, 2))
    expect(cleanupComplete, 'all paid requests must settle before teardown completes').toBe(true)
  })

  for (const id of [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-5-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5-1',
  ]) {
    test(`production thinking shape: ${id}`, async () => {
      test.skip(
        id === 'claude-fable-5-1' && process.env['TENON_LIVE_FABLE_30_DAY_RETENTION'] !== '1',
        'Fable requires explicitly confirmed 30-day retention configuration',
      )
      const model = anthropicDefinition.builtinModels.find((row) => row.id === id)
      if (model === undefined) throw new Error(`Missing builtin model ${id}`)
      const host = createMemoryHost()
      const provider = anthropicDefinition.create({
        network: host.network,
        clock: host.clock,
        config: {},
        secrets: { apiKey: 'encoding-only' },
      })
      const query: ProviderRequest = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Compute 27 times 43 and reply with the number only.' },
            ],
          },
        ],
        maxTokens: 4096,
        thinking:
          model.thinkingSpec?.mode === 'budget'
            ? { enabled: true, budgetTokens: 1024 }
            : { enabled: true },
        display: 'summarized',
        ...(model.thinkingSpec?.mode === 'budget' ? {} : { effort: 'low' }),
      }
      const encoded = provider.encode(query)
      expect((encoded.body as Body)['thinking']).toMatchObject(
        id === 'claude-haiku-4-5-20251001'
          ? { type: 'enabled', budget_tokens: 1024 }
          : { type: 'adaptive', display: 'summarized' },
      )
      const answer = await request(
        `shape-only-${id}`,
        { ...(encoded.body as Body), stream: false },
        false,
      )
      expect(answer.stop).toBe('end_turn')
    })
  }

  test('Opus 5.5 omitted thinking makes a signed tool round trip and records actual SSE pings', async () => {
    const messages: Message[] = [{ role: 'user', content: task }]
    const body = { ...base('claude-opus-5-5', messages), stream: true, tools: [tool] }
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
    const first = await request('omitted-first', body, false)
    const thinking = first.content.filter((block) => block.type === 'thinking')
    expect(thinking.length).toBeGreaterThan(0)
    for (const block of thinking) {
      expect(block['thinking']).toBe('')
      expect(typeof block['signature'] === 'string' && block['signature'].length > 0).toBe(true)
    }
    const last = await request(
      'omitted-tool-result',
      { ...body, messages: resultMessages(messages, first) },
      false,
    )
    expect(last.stop).toBe('end_turn')
    const pings = first.pingAtMs
    rows.push({
      label: 'ping-observation',
      pingCount: pings.length,
      largestGapMs: pings.reduce((max, value, i) => Math.max(max, value - (pings[i - 1] ?? 0)), 0),
      qualification:
        pings.length === 0
          ? 'No ping observed; this short response does not establish the 180s watchdog margin.'
          : 'Observed gaps only; long-thinking evidence must also be reviewed.',
    })
  })

  test('Opus 5.5 omitted long reasoning records repeated SSE ping intervals', async () => {
    const body = {
      ...base('claude-opus-5-5', [
        {
          role: 'user',
          content:
            'Solve this counting problem exactly, developing and checking the combinatorial recurrence yourself without tools. Count the permutations p of 1 through 22 such that p(i) is never i, never i+1 modulo 22, and never i+7 modulo 22. Give the exact integer and a concise explanation of a reproducible counting method. Check the recurrence on small analogous cycles and explain the consistency checks. Do not simply propose code or an unevaluated expression; work through the exact count carefully.',
        },
      ]),
      stream: true,
      max_tokens: 8192,
      output_config: { effort: 'high' },
    }
    const started = performance.now()
    const answer = await request('omitted-long-pings', body, false)
    const elapsed = performance.now() - started
    const checkpoints = [0, ...answer.pingAtMs, elapsed]
    const maximumGap = Math.max(...checkpoints.slice(1).map((at, i) => at - checkpoints[i]!))
    rows.push({
      label: 'long-ping-observation',
      elapsedMs: elapsed,
      pingCount: answer.pingAtMs.length,
      maximumGapMs: maximumGap,
    })
    expect(
      answer.pingAtMs.length,
      'A short response is not long-thinking evidence',
    ).toBeGreaterThanOrEqual(2)
    expect(elapsed).toBeGreaterThan(15_000)
    expect(
      maximumGap,
      'Observed ping gaps must remain well below the 180s idle watchdog',
    ).toBeLessThan(60_000)
    expect(['end_turn', 'max_tokens']).toContain(answer.stop)
  })

  test('strict history with tool use and result accepts a request with no tools', async () => {
    const messages: Message[] = [{ role: 'user', content: task }]
    const first = await request(
      'with-tools',
      { ...base('claude-opus-5-5', messages), tools: [tool] },
      true,
    )
    const builtin = anthropicDefinition.builtinModels.find(
      (model) => model.id === 'claude-opus-5-5',
    )
    if (builtin === undefined) throw new Error('Missing Opus 5.5 builtin')
    const { thinkingSpec, ...rest } = builtin
    expect(thinkingSpec).toBeDefined()
    // A hand-typed row has no thinkingSpec and uses conservative drop retention. Rule 3 drops
    // reasoning; it does not rewrite tool use/results or pretend a changed prefix was preserved.
    const target = {
      model: { ...rest, thinkingPreservationFormat: 'drop' as const },
      hasTools: false,
    }
    const filtered = first.content.filter((block) => {
      if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return true
      const source = { provider: builtin.providerId, providerModel: builtin.id }
      const decision = decideThinking(
        block.type === 'thinking'
          ? {
              ...source,
              type: 'thinking',
              text: String(block['thinking'] ?? ''),
              signature: String(block['signature'] ?? ''),
            }
          : { ...source, type: 'redacted-thinking', data: String(block['data'] ?? '') },
        target,
      )
      rows.push({ label: 'hand-typed-history-guard', blockType: block.type, ...decision })
      expect(decision).toEqual({ action: 'drop', reason: 'target-drops' })
      return decision.action !== 'drop'
    })
    expect(filtered.filter((block) => block.type === 'tool_use')).toEqual(
      first.content.filter((block) => block.type === 'tool_use'),
    )
    const originalHistory = resultMessages(messages, first)
    const history = resultMessages(messages, { ...first, content: filtered })
    expect(history.at(-1)).toEqual(originalHistory.at(-1))
    const without = base('claude-opus-5-5', history)
    expect(without).not.toHaveProperty('tools')
    const last = await request('history-without-tools', without, true)
    expect(last.stop).toBe('end_turn')
  })

  test('strict top-level cache control hits on the second request and records effort changes', async () => {
    // Distinct run salts prevent the no-cache control from accidentally sharing the cached prefix.
    const paragraph =
      'The archival ledger describes ordinary numbered rooms, their blue doors, public opening hours, and a visitor map. '
    const history = [{ role: 'user' as const, content: 'Reply OK only.' }]
    for (const cache of [false, true]) {
      const body = {
        ...base('claude-opus-5-5', history),
        system: `${randomUUID()}\n${paragraph.repeat(350)}`,
        output_config: { effort: 'low' },
        ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
      }
      // oxlint-disable-next-line no-await-in-loop -- measure warm-up then repeated identical prefix
      const first = await request(`cache-${cache}-first`, body, true)
      // oxlint-disable-next-line no-await-in-loop -- second must follow completion of first
      const second = await request(`cache-${cache}-second`, body, true)
      const input =
        Number(first.usage['input_tokens'] ?? 0) +
        Number(first.usage['cache_creation_input_tokens'] ?? 0) +
        Number(first.usage['cache_read_input_tokens'] ?? 0)
      expect(input).toBeGreaterThan(512)
      if (cache) {
        expect(Number(second.usage['cache_read_input_tokens'] ?? 0)).toBeGreaterThan(0)
        // oxlint-disable-next-line no-await-in-loop -- same cached prefix, only effort changes
        await request('cache-effort-high', { ...body, output_config: { effort: 'high' } }, true)
      }
    }
  })

  test('Opus 5 partial tool input is discarded and continue follows the retained history', async () => {
    const messages: Message[] = [
      {
        role: 'user',
        content:
          'Call store once. Its text must be the word HELLO repeated 5000 times, separated by spaces. Do not write any other text.',
      },
    ]
    const body = {
      ...base('claude-opus-5', messages),
      stream: true,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      tool_choice: { type: 'tool', name: 'store' },
      tools: [
        {
          name: 'store',
          description: 'Store the requested public fixture text.',
          input_schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
    }
    const cut = await request('strict-tool-input-cut', body, true)
    expect(cut.stop).toBe('max_tokens')
    expect(cut.partialTools).toBeGreaterThan(0)
    expect(cut.content.some((block) => block.type === 'tool_use')).toBe(false)
    // Spec §continue: double only if no assistant content survived; otherwise append the stored
    // continuation text after exactly the retained complete blocks, never replay partial tool JSON.
    const next =
      cut.content.length === 0
        ? { ...body, max_tokens: 2048 }
        : {
            ...body,
            messages: [
              ...messages,
              { role: 'assistant' as const, content: cut.content },
              { role: 'user' as const, content: MODEL_NOTES.continuation['output-truncated'] },
            ],
          }
    rows.push({
      label: 'continuation-path',
      retainedBlocks: cut.content.length,
      mode: cut.content.length === 0 ? 'whole-turn-double' : 'append-continuation',
    })
    const continued = await request('strict-truncated-continue', next, true)
    expect(['tool_use', 'max_tokens']).toContain(continued.stop)
    expect(continued.complete).toBe(true)
  })
})
