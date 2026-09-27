/**
 * The first sentence, as the language splits it (spec 02 §思考的默认与显示: `Intl.Segmenter(locale,
 * { granularity: 'sentence' })`); empty for an empty block.
 */
export function firstSentence(text: string, locale: string): string {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })
  for (const { segment } of segmenter.segment(text.trim())) return segment.trim()
  return ''
}
