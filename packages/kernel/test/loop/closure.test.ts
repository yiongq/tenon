/**
 * The closure notes (spec 02 §原因码表, §提示层「closure 要填满的格」; plan step 14, moved from step
 * 18): every cell the table needs holds non-empty English, no other cell exists, and a cell names no
 * slot its source cannot fill — a blocking code's `BLOCKED_FACT_KEYS`, nothing for the rest.
 */
import { describe, expect, it } from 'vitest'
import type { ExecutionState } from '../../src/index.js'
import { BLOCKED_FACT_KEYS, isBlockReason } from '../../src/loop/closure.js'
import { MODEL_NOTES, fill } from '../../src/prompts/index.js'
import type { ClosureNoteSource } from '../../src/prompts/index.js'

/** §提示层「closure 要填满的格」, cell by cell. A new source is a compile error here. */
const CELLS = {
  'user-rejected': ['not-run'],
  superseded: ['not-run'],
  policy: ['not-run'],
  'user-disabled': ['not-run'],
  protected: ['not-run'],
  inspector: ['not-run'],
  'tool-unavailable': ['not-run'],
  'invalid-input': ['not-run'],
  'output-truncated': ['not-run'],
  'step-limit': ['not-run'],
  'no-progress': ['not-run'],
  'usage-limit': ['not-run'],
  'blocked-repeatedly': ['not-run'],
  'content-filter': ['not-run'],
  'provider-error': ['not-run'],
  stopped: ['not-run', 'aborted', 'uncertain'],
  'app-exit': ['not-run', 'aborted', 'uncertain'],
  crashed: ['not-run', 'uncertain'],
  repair: ['not-run', 'uncertain'],
  'timed-out': ['aborted', 'uncertain'],
  unanswered: ['aborted'],
} as const satisfies Record<ClosureNoteSource, readonly ExecutionState[]>

const SOURCES = Object.keys(CELLS) as ClosureNoteSource[]

function slotsOf(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1] ?? '')
}

describe('MODEL_NOTES.closure', () => {
  it('has exactly the cells the reason table needs', () => {
    expect(Object.keys(MODEL_NOTES.closure).toSorted()).toEqual([...SOURCES].toSorted())
    for (const source of SOURCES) {
      expect(Object.keys(MODEL_NOTES.closure[source]).toSorted(), `${source}`).toEqual(
        [...CELLS[source]].toSorted(),
      )
    }
  })

  it('writes each cell in non-empty English, with no slot its source cannot fill', () => {
    for (const source of SOURCES) {
      const allowed = isBlockReason(source) ? BLOCKED_FACT_KEYS[source] : []
      for (const state of CELLS[source]) {
        const text = MODEL_NOTES.closure[source][state] ?? ''
        expect(text.trim().length, `${source}/${state}`).toBeGreaterThan(0)
        // English only: a model reads it, and the interface's copy comes from the locales.
        expect(text, `${source}/${state}`).toMatch(/^[ -~’]+$/u)
        for (const slot of slotsOf(text)) expect(allowed, `${source}/${state}`).toContain(slot)
        const slots = Object.fromEntries(allowed.map((key) => [key, `<${key}>`]))
        expect(() => fill(text, slots)).not.toThrow()
      }
    }
  })
})
