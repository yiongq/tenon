import type { EvalCheck } from './types.js'
import { callsOf, readSession } from './support.js'
import { jsonFile } from './task-data.js'
const check: EvalCheck = async (ctx) => {
  const entries = await readSession(ctx.tape, ctx.sessionId)
  const calls = callsOf(entries)
  const results = new Map(
    entries
      .filter((e) => e.name === 'tool/result')
      .map((e) => [`${e.sourceId}:${e.sourceSeq}:${String(e.payload['ordinal'])}`, e.entryId]),
  )
  const urls = [
    ...Array.from({ length: 5 }, (_, i) => `https://research.example.test/result-${i + 1}`),
    ...[1, 2].map((i) => `https://research.example.test/detail-${i}`),
  ]
  const fetched = urls.every((url) =>
    calls.some(
      (c) =>
        c.name === 'WebFetch' &&
        c.input['url'] === url &&
        c.result?.isError === false &&
        c.outcome?.state === 'completed',
    ),
  )
  const search = calls.find((c) => c.name === 'WebSearch' && c.result?.isError === false)
  const localRead = calls.find(
    (c) =>
      c.name === 'Read' &&
      String(c.input['file_path']).endsWith('/project.json') &&
      c.result?.isError === false,
  )
  const firstPages = urls
    .slice(0, 5)
    .map((url) =>
      calls.find(
        (c) => c.name === 'WebFetch' && c.input['url'] === url && c.result?.isError === false,
      ),
    )
  const pageResults = firstPages.map((c) => (c === undefined ? undefined : results.get(c.key)))
  const readResult = localRead === undefined ? undefined : results.get(localRead.key)
  const searchResult = search === undefined ? undefined : results.get(search.key)
  const ordered =
    readResult !== undefined &&
    search !== undefined &&
    search.entryId > readResult &&
    searchResult !== undefined &&
    firstPages.every((c) => c !== undefined && c.entryId > searchResult) &&
    pageResults.every((id) => id !== undefined) &&
    [1, 2].every((i) => {
      const detail = calls.find(
        (c) =>
          c.name === 'WebFetch' &&
          c.input['url'] === `https://research.example.test/detail-${i}` &&
          c.result?.isError === false,
      )
      // Tool calls in one model reply are prewritten together: call order alone proves no dependency.
      return (
        detail !== undefined && pageResults.every((id) => id !== undefined && detail.entryId > id)
      )
    })
  const linkCards = [1, 2].every((i) =>
    ctx.cards.some(
      (card) =>
        card.reason === 'flagged' &&
        card.target?.type === 'url' &&
        card.target.url === `https://research.example.test/detail-${i}`,
    ),
  )
  const flagged = ctx.cards.filter((c) => c.reason === 'flagged')
  const result = await jsonFile('research.json', { capacity: 150, reserve: 9 })(ctx)
  return {
    pass: fetched && ordered && linkCards && result.pass,
    note: `All seven actual fetch results=${fetched}; file-before-search-before-fetch=${ordered}; linked targets flagged=${linkCards}; flagged extra cards=${flagged.length}, expected=2; excess=${Math.max(0, flagged.length - 2)}; ${result.note}`,
  }
}
export default check
