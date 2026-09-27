import { applyPercentOff, formatCents, toCents } from './money.js'

export function lineTotal(item) {
  return toCents(item.price) * item.quantity
}

export function cartTotal(items, discountPercent = 0) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0)
  return applyPercentOff(subtotal, discountPercent)
}

export function receipt(items, discountPercent = 0) {
  const lines = items.map(
    (item) => `${item.name} x${item.quantity}  ${formatCents(lineTotal(item))}`,
  )
  if (discountPercent > 0) lines.push(`Discount  ${discountPercent}%`)
  lines.push(`Total  ${formatCents(cartTotal(items, discountPercent))}`)
  return lines.join('\n')
}
