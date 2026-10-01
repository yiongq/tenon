export function pages(items, size) {
  const result = []
  for (let i = 0; i <= items.length; i += size) result.push(items.slice(i, i + size))
  return result
}
