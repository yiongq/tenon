/** The converter and one-hop loop, independent of provider or host implementation. */
import { describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, HostNetworkDeniedError } from '../../src/index.js'
import type { FetchLike } from '../../src/index.js'
import {
  WEB_FETCH_TOOL,
  webFetchExecutor,
  FETCH_CONVERT_MAX_BYTES,
} from '../../src/tools/builtin/web-fetch.js'
import type { ToolExecution } from '../../src/tools/executor.js'

function execute(
  fetch: FetchLike,
  canFollow = async (_url: string) => true,
  signal = new AbortController().signal,
) {
  const host = createMemoryHost()
  return webFetchExecutor({
    item: {
      source: 'builtin',
      serverId: 'builtin',
      originalName: 'WebFetch',
      name: 'WebFetch',
      spec: WEB_FETCH_TOOL.spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    input: { url: 'https://a.example/path/start' },
    signal,
    target: null,
    scope: {
      roots: [],
      profileDir: absolutePath('/profile'),
      ownSpillDir: absolutePath('/profile/tool-output/session'),
      protectedFiles: [],
    },
    fs: host.fs,
    clock: host.clock,
    webFetch: { fetch, canFollow },
  })
}
const text = (result: ToolExecution) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
const response = (body: BodyInit, type = 'text/html') =>
  new Response(body, { headers: { 'content-type': type } })
/** `html` with its one 中文 encoded as GBK and the rest as ASCII. */
const gbk = (html: string) => {
  const [before, after] = html.split('中文').map((part) => new TextEncoder().encode(part))
  return new Uint8Array([...(before ?? []), 0xd6, 0xd0, 0xce, 0xc4, ...(after ?? [])])
}

describe('WebFetch content', () => {
  it('converts HTML with absolute links and tables but no script/style contents', async () => {
    const result = await execute(async () =>
      response(
        '<h1>Hello</h1><script>SECRET_SCRIPT</script><style>SECRET_STYLE</style><p><a href="../about">About</a></p><table><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>two</td></tr></table>',
      ),
    )
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('# Hello')
    expect(text(result)).toContain('https://a.example/about')
    expect(text(result)).toContain('| A | B |')
    expect(text(result)).not.toMatch(/SECRET_SCRIPT|SECRET_STYLE/)
  })

  it('handles deeply nested markup without recursive overflow', async () => {
    const result = await execute(async () =>
      response(`${'<div>'.repeat(5000)}kept${'</div>'.repeat(5000)}`),
    )
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('kept')
  })

  it.each(['text/html; charset=gbk', 'text/html'])(
    'decodes GBK using %s or the meta fallback',
    async (type) => {
      const prefix = new TextEncoder().encode(
        '<meta content="text/html; charset=gbk" http-equiv="Content-Type"><p>',
      )
      const suffix = new TextEncoder().encode('</p>')
      const bytes = new Uint8Array([...prefix, 0xd6, 0xd0, 0xce, 0xc4, ...suffix])
      const result = await execute(async () => response(bytes, type))
      expect(text(result)).toContain('中文')
      expect(result.isError).toBe(false)
    },
  )

  it('lets the HTTP charset override conflicting meta and defaults to UTF-8', async () => {
    const result = await execute(async () =>
      response('<meta charset="gbk"><p>中文</p>', 'text/html; charset="UTF-8"'),
    )
    expect(text(result)).toContain('中文')
    expect(text(await execute(async () => response('<p>中文</p>')))).toBe('中文')
  })

  it.each([
    ['repeated unclosed tags', '<meta '.repeat(Math.floor(FETCH_CONVERT_MAX_BYTES / 6))],
    ['one long attribute name', `<meta ${'a'.repeat(FETCH_CONVERT_MAX_BYTES - 7)}>`],
  ])('prescans a hostile 1 MB page with %s in bounded time', async (_shape, page) => {
    const started = performance.now()
    const result = await execute(async () => response(page))
    expect(result.isError).toBe(false)
    // A whole-body scan with rescanning patterns took about a minute on the first shape.
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('looks for a <meta> charset only in the first 1024 bytes', async () => {
    const late = `<!--${'x'.repeat(1024)}--><meta charset="gbk"><p>中文</p>`
    expect(text(await execute(async () => response(late)))).toContain('中文')
  })

  it.each([
    ['an unknown header label to the meta', 'text/html; charset=utf8mb4', '<meta charset="gbk">'],
    [
      'an unknown meta label to the next meta',
      'text/html',
      '<meta charset="foo"><meta charset=gbk>',
    ],
  ])('falls back from %s', async (_case, type, meta) => {
    const result = await execute(async () => response(gbk(`${meta}<p>中文</p>`), type))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('中文')
  })

  it('decodes as UTF-8 when no label is known', async () => {
    const result = await execute(async () =>
      response('<meta charset="foo"><p>中文</p>', 'text/html; charset=utf8mb4'),
    )
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('中文')
  })

  it.each(['text/html', 'text/plain; charset=bogus'])(
    'reads a UTF-16 BOM when %s gives no usable label',
    async (type) => {
      const units = [...'<p>中文</p>'].map((c) => c.charCodeAt(0))
      const bytes = new Uint8Array([0xff, 0xfe, ...units.flatMap((u) => [u & 255, u >> 8])])
      expect(text(await execute(async () => response(bytes, type)))).toContain('中文')
    },
  )

  it.each(['text/html', 'text/plain'])(
    'rejects an oversized %s body before decoding and cancels the remaining stream',
    async (type) => {
      const cancel = vi.fn<() => void>()
      const result = await execute(async () =>
        response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(FETCH_CONVERT_MAX_BYTES + 1))
            },
            cancel,
          }),
          type,
        ),
      )
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(String(FETCH_CONVERT_MAX_BYTES + 1))
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it('decodes other text by its header charset alone, without reading <meta>', async () => {
    expect(text(await execute(async () => response(gbk('中文'), 'text/plain; charset=gbk')))).toBe(
      '中文',
    )
    expect(
      text(await execute(async () => response('<meta charset="gbk">中文', 'text/plain'))),
    ).toBe('<meta charset="gbk">中文')
  })

  it('returns plain text unchanged, and reports non-text types and HTTP errors', async () => {
    expect(text(await execute(async () => response('  raw\ntext ', 'text/plain')))).toBe(
      '  raw\ntext ',
    )
    const binary = await execute(async () => response('binary', 'application/octet-stream'))
    expect(binary.isError).toBe(true)
    expect(text(binary)).toContain('application/octet-stream')
    const failed = await execute(async () => new Response('unavailable', { status: 503 }))
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('503')
  })
})

describe('WebFetch redirects and failures', () => {
  it('follows relative same-host URLs, writes the final URL and cancels each abandoned body', async () => {
    const seen: string[] = []
    const cancel = vi.fn<() => void>()
    const rejudge = vi.fn<(url: string) => Promise<boolean>>(async (_url) => true)
    const result = await execute(async (url, init) => {
      seen.push(String(url))
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
      return seen.length === 1
        ? new Response(new ReadableStream({ cancel }), {
            status: 302,
            headers: { location: '../finish' },
          })
        : response('<p>Done</p>')
    }, rejudge)
    expect(seen).toEqual(['https://a.example/path/start', 'https://a.example/finish'])
    expect(rejudge).toHaveBeenCalledExactlyOnceWith('https://a.example/finish')
    expect(cancel).toHaveBeenCalledOnce()
    expect(text(result)).toContain('Final URL: https://a.example/finish')
  })

  it.each(['status', 'type', 'location', 'body', 'network'])(
    'retains the final URL when a followed redirect ends in a %s failure',
    async (failure) => {
      let calls = 0
      const result = await execute(async () => {
        if (++calls === 1)
          return new Response(null, { status: 302, headers: { location: '/next' } })
        if (failure === 'status') return new Response(null, { status: 404 })
        if (failure === 'type') return response('binary', 'application/octet-stream')
        if (failure === 'location') return new Response(null, { status: 302 })
        if (failure === 'network') throw new Error('connection failed')
        return response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('body failed'))
            },
          }),
          'text/plain',
        )
      })
      expect(result).toMatchObject({ state: 'completed', isError: true })
      expect(text(result)).toContain('Final URL: https://a.example/next')
      expect(calls).toBe(2)
    },
  )

  it.each([
    'https://b.example/next',
    'http://127.0.0.1/private',
    'https://user:password@a.example/private',
  ])('does not fetch %s or mark an announced redirect as an error', async (location) => {
    const fetch = vi.fn<FetchLike>(
      async () => new Response(null, { status: 302, headers: { location } }),
    )
    const result = await execute(fetch)
    expect(fetch).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(location)
  })

  it('does not follow a same-host hop whose recheck asks or denies', async () => {
    const fetch = vi.fn<FetchLike>(
      async () => new Response(null, { status: 307, headers: { location: '/blocked' } }),
    )
    const result = await execute(fetch, async () => false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('https://a.example/blocked')
  })

  it.each([{}, { location: 'http://[' }])(
    'reports an unusable redirect Location: %j',
    async (headers) => {
      const result = await execute(async () => new Response(null, { status: 302, headers }))
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('302')
    },
  )

  it('allows twenty redirects and refuses the twenty-first without another request', async () => {
    let count = 0
    const result = await execute(
      async () => new Response(null, { status: 302, headers: { location: `/hop${++count}` } }),
    )
    expect(count).toBe(21)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('20 redirects')
  })

  it('separates host protection, ordinary network failure and user abort', async () => {
    const denied = await execute(async () => {
      throw new HostNetworkDeniedError('private address')
    })
    expect(denied).toMatchObject({
      state: 'not-run',
      source: 'protected',
      facts: { toolName: 'WebFetch', target: 'a.example' },
    })
    const failed = await execute(async () => {
      throw new TypeError('connection failed')
    })
    expect(failed).toMatchObject({ state: 'completed', isError: true })
    expect(failed.source).toBeUndefined()
    const controller = new AbortController()
    const aborted = await execute(
      async () => {
        controller.abort()
        throw controller.signal.reason
      },
      undefined,
      controller.signal,
    )
    expect(aborted).toMatchObject({ state: 'aborted' })
    expect(aborted.source).toBeUndefined()
  })
})
