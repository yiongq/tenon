import type { EvalCheck } from './types.js'
import { readSession, readText } from './support.js'
function normalize(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(normalize)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, normalize(item)]),
        )
      : value
}
export function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected))
}
export function jsonFile(file: string, expected: unknown): EvalCheck {
  return async ({ workspaceDir }) => {
    const text = await readText(workspaceDir, file)
    try {
      return {
        pass: text !== null && sameJson(JSON.parse(text), expected),
        note: `Exact structured output: ${file}`,
      }
    } catch {
      return { pass: false, note: `${file} is missing or invalid JSON` }
    }
  }
}
export function jsonReply(expected: unknown): EvalCheck {
  return async ({ tape, sessionId }) => {
    const last = (await readSession(tape, sessionId)).findLast(
      (e) => e.name === 'message/assistant',
    )
    const content = last?.payload['content'] as Array<{ type: string; text?: string }> | undefined
    const text = (content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '')
    try {
      return {
        pass: sameJson(JSON.parse(text), expected),
        note: 'Exact final JSON data compared; prose style is not scored',
      }
    } catch {
      return { pass: false, note: 'Final response is not a JSON value' }
    }
  }
}
