import { expect, it } from 'vitest'
import { hostOfUrl } from '../src/renderer/src/lib/url-host.js'

it('hostOfUrl: lowercase, punycode, one trailing dot dropped, a backslash read as a path separator', () => {
  for (const [url, host] of [
    ['https://EXAMPLE.COM:8443/a?q=x#fragment', 'example.com'],
    ['https://аpple.com/x', 'xn--pple-43d.com'],
    ['https://EXAMPLE.COM./x', 'example.com'],
    ['https://EXAMPLE.COM../x', 'example.com.'],
    ['https://evil.com\\.good.com', 'evil.com'],
    ['https://user:password@Example.com/x', 'example.com'],
    ['http://[::1]:1234/', '[::1]'],
  ])
    expect(hostOfUrl(url ?? '')).toBe(host)
})
