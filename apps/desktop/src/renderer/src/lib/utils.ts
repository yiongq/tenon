import { createCn } from 'cn/config'

/**
 * Class-name joining with Tailwind conflict resolution, taught Tenon's own type steps.
 *
 * The stock merger knows only Tailwind's t-shirt sizes. To it `text-ui-sm` or `text-micro` is a
 * COLOUR, so it dropped whichever of a size and a colour came first: a small primary button lost
 * `text-primary-foreground` (dark text on the dark accent, 2:1), and a tool output's `text-micro`
 * vanished next to `text-text-primary`. Every component imports `cn` from here, never from 'cn'.
 */
export const cn = createCn({
  extend: {
    classGroups: { 'font-size': [{ text: ['micro', 'ui-sm', 'ui', 'body', 'h1', 'h2', 'h3'] }] },
  },
})
