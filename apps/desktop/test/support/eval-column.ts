/**
 * The eval-only instance column for the offline eval tests (M6 §点名 (d)): the column `pnpm eval`
 * resolves for `anthropic` + `glm-5.3`, its public address sent to a fake Anthropic server on this
 * machine through the test seam's redirect (M6 §点名「测试接缝」), and that server answering the
 * runner's probe first — ① a `Read` call, ② a closing text, so the row passes (M6 推出的读法 35).
 */
import { resolveColumn } from '../../evals/models.js'
import type { EvalColumn } from '../../evals/models.js'
import { startFakeAnthropic } from './fake-anthropic.js'
import type { FakeAnthropic, RecordedRequest, ScriptedReply } from './fake-anthropic.js'

export const INSTANCE_COLUMN: EvalColumn = resolveColumn({
  TENON_EVAL_PROVIDER: 'anthropic',
  TENON_EVAL_MODEL: 'glm-5.3',
})

/** The probe's two replies (§两步): what the fake answers before any request of the task. */
export const PROBE_REPLIES: readonly ScriptedReply[] = [
  {
    steps: [
      {
        type: 'tool_use',
        id: 'toolu_probe',
        name: 'Read',
        input: { file_path: '/tenon-probe/ping.txt' },
      },
    ],
  },
  { steps: [{ type: 'text', text: 'It reads ok.' }] },
]

/** `requests` holds the task's requests only; `probes` the two that came before them. */
export type InstanceFake = FakeAnthropic & { readonly probes: readonly RecordedRequest[] }

/**
 * A fake for the instance column: the probe's replies first, then `replies` by the index of the
 * task's own requests (0 = the first turn's).
 */
export async function startInstanceFake(
  replies: (index: number, body: unknown) => ScriptedReply | undefined,
): Promise<InstanceFake> {
  const server = await startFakeAnthropic({
    delayMs: 1,
    replies: (index, body) =>
      index < PROBE_REPLIES.length
        ? PROBE_REPLIES[index]
        : replies(index - PROBE_REPLIES.length, body),
  })
  return new Proxy(server as InstanceFake, {
    get(target, key, receiver) {
      if (key === 'requests') return target.requests.slice(PROBE_REPLIES.length)
      if (key === 'probes') return target.requests.slice(0, PROBE_REPLIES.length)
      return Reflect.get(target, key, receiver)
    },
  })
}

/** `runTask`'s `originMap`: the column's origin sent to `server`. */
export function originMapTo(column: Pick<EvalColumn, 'baseURL'>, server: FakeAnthropic): string {
  return `${new URL(column.baseURL).origin}=${server.baseURL}`
}
