import { endpointOf } from '../endpoint.js'
export function mcpAddress(
  input: string,
): { ok: true; url: string } | { ok: false; code: 'invalid-address' | 'https-required' } {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, code: 'invalid-address' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return { ok: false, code: 'invalid-address' }
  if (url.protocol === 'http:' && endpointOf(url.href)?.reach === 'public')
    return { ok: false, code: 'https-required' }
  url.hash = ''
  return { ok: true, url: url.href }
}
