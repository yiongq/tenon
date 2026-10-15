/**
 * The renderer's class-name merger knows Tenon's type steps (theme.css `--text-*`). The stock one
 * took `text-ui-sm` and `text-micro` for colours and dropped one of a size and a colour that met:
 * the small primary button lost its white text on the dark accent (2:1), and tool output lost its
 * 12px size next to its text colour.
 */
import { describe, expect, it } from 'vitest'
import { cn } from '../src/renderer/src/lib/utils.js'

const words = (classes: string): string[] => classes.split(' ').toSorted()

describe('cn', () => {
  it('keeps a Tenon size beside a text colour, whichever comes first', () => {
    expect(words(cn('text-primary-foreground', 'text-ui-sm'))).toEqual(
      words('text-primary-foreground text-ui-sm'),
    )
    expect(words(cn('text-micro text-text-primary'))).toEqual(words('text-micro text-text-primary'))
    for (const size of ['micro', 'ui-sm', 'ui', 'body', 'h1', 'h2', 'h3']) {
      expect(cn(`text-${size}`, 'text-text-muted')).toBe(`text-${size} text-text-muted`)
    }
  })

  it('still resolves two sizes, or two colours, to the last one', () => {
    expect(cn('text-micro', 'text-ui')).toBe('text-ui')
    expect(cn('text-sm', 'text-ui-sm')).toBe('text-ui-sm')
    expect(cn('text-text-muted', 'text-text-primary')).toBe('text-text-primary')
  })
})
