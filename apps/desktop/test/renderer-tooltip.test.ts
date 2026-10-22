import { expect, it } from 'vitest'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'

const tooltipPath = '../src/renderer/src/components/ui/tooltip.tsx'

it('tooltip content declares role=tooltip and keeps its supplied text', async () => {
  // Inspect the real wrapper's popup before its portal mounts. Hover and placement remain e2e
  // checks; this pins the accessibility role that Base UI's Popup does not supply itself.
  const { TooltipContent } = await import(tooltipPath)
  const portal = TooltipContent({ children: "Can't be undone" })
  const popup = portal.props.children.props.children
  expect(popup.type).toBe(TooltipPrimitive.Popup)
  expect(popup.props.role).toBe('tooltip')
  expect(popup.props.children[0]).toBe("Can't be undone")
})
