/**
 * The collapsed thinking block's line (spec 02 §思考的默认与显示 `ThinkingBlock`; plan step 20, 旧 226
 * logic part): the first sentence by `Intl.Segmenter(locale, { granularity: 'sentence' })`, nothing
 * for a block with no text. One zh-CN and one en case, as the plan asks, and the edges.
 */
import { describe, expect, it } from 'vitest'
import { firstSentence } from '../src/renderer/src/lib/first-sentence.js'

describe('firstSentence', () => {
  it('zh-CN: stops at the first 。 even with no space after it', () => {
    expect(firstSentence('先看一下目录结构。然后读取 README，再决定怎么改。', 'zh-CN')).toBe(
      '先看一下目录结构。',
    )
    expect(firstSentence('用户要一份周报？我先确认格式。', 'zh-CN')).toBe('用户要一份周报？')
  })

  it('en: the first sentence, without the space that follows it', () => {
    expect(
      firstSentence('The user wants a weekly report. I should check the format first.', 'en'),
    ).toBe('The user wants a weekly report.')
    expect(firstSentence('Let me look at the file first! Then decide.', 'en')).toBe(
      'Let me look at the file first!',
    )
  })

  it('trims the block before and the sentence after, and keeps a block of one sentence whole', () => {
    expect(firstSentence('  \n  Checking the tests. Then the build.  ', 'en')).toBe(
      'Checking the tests.',
    )
    expect(firstSentence('no full stop at all', 'en')).toBe('no full stop at all')
  })

  it('shows nothing for an empty or blank block', () => {
    expect(firstSentence('', 'en')).toBe('')
    expect(firstSentence(' \n\t ', 'zh-CN')).toBe('')
  })
})
