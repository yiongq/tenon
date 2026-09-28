/** SQLite verifies the development gate and summary request audit from persisted originals. */
import { createMemoryHost, createSessionService, rebuildProviderContext } from '@tenon-app/kernel'
import type { ModelInfo, TapeStore } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  recheckAttempt,
  scriptedTurn,
} from '@tenon-app/kernel/testing'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPACTION_THRESHOLD_ENV,
  compactionTestOptions,
} from '../src/main/compaction-test-seam.js'
import { desktopInspectors } from '../src/main/inspectors.js'
import { openStore, removeTempProfiles } from './tape/fixtures.js'

const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const MODEL: ModelInfo = {
  id: 'compaction-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
const stores: TapeStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  removeTempProfiles()
})

describe('persisted compaction through the desktop development seam', () => {
  it.each([false, true])(
    'packaged=%s gates the same low threshold and summary hashes re-encode',
    async (isPackaged) => {
      const opened = openStore({ label: 'compaction' })
      stores.push(opened.store)
      const host = createMemoryHost({ identity: opened.identity })
      const provider = createScriptedProvider({ models: [MODEL] })
      const ids = createCounterIds()
      const connect = (tape: TapeStore, options: { compactionThreshold?: number }) => {
        const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
        const service = createSessionService({
          host,
          tape,
          ids,
          connector: loop.connector,
          inspectors: desktopInspectors(),
          protectedFiles: [],
          log: () => {},
          ...options,
        })
        service.bindLoop(loop)
        return { service, loop }
      }
      let h = connect(opened.store, {})
      // Three complete turns leave something to summarize while retaining the last two.
      for (const text of ['oldest source', 'retained second', 'retained third']) {
        provider.script(scriptedTurn({ deltas: [`answer to ${text}`] }))
        // oxlint-disable-next-line no-await-in-loop -- each turn is a distinct persisted boundary
        await h.service.send({ sessionId: SESSION, origin: null, text })
        // oxlint-disable-next-line no-await-in-loop -- wait before starting the next turn
        expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
      }
      await opened.store.close()
      const reopened = openStore({ label: 'compaction', profileDir: opened.profileDir })
      stores.push(reopened.store)
      h = connect(
        reopened.store,
        compactionTestOptions(isPackaged, { [COMPACTION_THRESHOLD_ENV]: '1' }),
      )
      await h.service.recover()
      const before = provider.starts
      if (!isPackaged)
        provider.script(scriptedTurn({ deltas: ['A durable summary of the oldest source'] }))
      provider.script(scriptedTurn({ deltas: ['Fourth answer'] }))
      await h.service.send({ sessionId: SESSION, origin: null, text: 'fourth boundary' })
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
      expect(provider.starts - before).toBe(isPackaged ? 1 : 2)
      await reopened.store.close()
      const audited = openStore({ label: 'compaction', profileDir: opened.profileDir })
      stores.push(audited.store)
      const entries = (await audited.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
      const anchors = entries.filter((entry) => entry.name === 'compaction/anchor')
      const summaries = entries.filter(
        (entry) =>
          entry.name === 'provider/attempt_completed' && entry.payload['compaction'] !== undefined,
      )
      expect(anchors).toHaveLength(isPackaged ? 0 : 1)
      expect(summaries).toHaveLength(isPackaged ? 0 : 1)
      if (isPackaged) return
      const summary = summaries[0]
      if (summary === undefined) throw new Error('Summary attempt missing')
      const audit = await recheckAttempt(audited.store, {
        sessionId: SESSION,
        attempt: summary,
        currentModel: (providerId, modelId) =>
          providerId === MODEL.providerId && modelId === MODEL.id ? MODEL : null,
      })
      expect(audit.verdict).toBe('verified')
      if (audit.verdict !== 'verified') throw new Error(JSON.stringify(audit))
      expect(provider.encode(audit.request).promptHash).toBe(summary.payload['promptHash'])
      const metadata = summary.payload['compaction'] as { requestText: string }
      expect(audit.request.messages.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: metadata.requestText }],
      })
      expect(JSON.stringify(audit.request.messages)).toContain('oldest source')
      expect(JSON.stringify(audit.request.messages)).not.toContain('fourth boundary')
      expect(audit.request.tools).toBeUndefined()
      const context = await rebuildProviderContext(audited.store, {
        sessionId: SESSION,
        target: MODEL,
      })
      expect(JSON.stringify(context)).toContain('A durable summary of the oldest source')
      expect(
        entries.filter(
          (entry) =>
            entry.name === 'view/tool_table' && entry.payload['reason'] === 'after-compaction',
        ),
      ).toHaveLength(1)
    },
  )
})
