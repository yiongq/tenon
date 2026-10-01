/** The address ranges in spec 02 §本机抓取器. Pure: DNS and sockets belong to the host. */
export function isBlockedFetchAddress(address: string): boolean {
  if (!/^[0-9a-fA-F:.[\]]+$/u.test(address)) return true
  let host: string
  try {
    host = new URL(
      `http://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}/`,
    ).hostname
  } catch {
    return true
  }
  if (!host.startsWith('[')) {
    const parts = host.split('.')
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) return true
    const [a = 0, b = 0, c = 0, d = 0] = parts.map(Number)
    return (
      a === 127 ||
      a === 10 ||
      (a === 0 && b === 0 && c === 0 && d === 0) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  const [left = '', right] = host.slice(1, -1).split('::')
  const head = left === '' ? [] : left.split(':')
  const tail = right === undefined || right === '' ? [] : right.split(':')
  const words = [
    ...head,
    ...Array.from({ length: 8 - head.length - tail.length }, () => '0'),
    ...tail,
  ].map((word) => Number.parseInt(word, 16))
  const [first = 0] = words
  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 0 || words[7] === 1))
    return true
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const high = words[6] ?? 0
    const low = words[7] ?? 0
    return isBlockedFetchAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)
  }
  return false
}

/** URL literal checks happen before permissions; WHATWG normalises unusual IPv4 spellings. */
export function isBlockedFetchUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return true
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '')
    return true
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (host.startsWith('[') || /^\d+(?:\.\d+){3}$/u.test(host)) return isBlockedFetchAddress(host)
  return !host.includes('.')
}
