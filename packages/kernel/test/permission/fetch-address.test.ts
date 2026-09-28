import { describe, expect, it } from 'vitest'
import { isBlockedFetchAddress, isBlockedFetchUrl } from '../../src/permission/fetch-address.js'
import { hostOfUrl } from '../../src/permission/reversibility.js'

describe('WebFetch literal boundary', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://public.example/file',
    'https://u:p@public.example',
    'http://localhost',
    'http://LOCALHOST.',
    'http://printer',
    'http://0',
    'http://2130706433',
    'http://0x7f000001',
    'http://127.1',
    'http://0177.0.0.1',
    'http://10.1.2.3',
    'http://172.16.1.1',
    'http://172.31.255.255',
    'http://192.168.0.1',
    'http://169.254.1.1',
    'http://[::]',
    'http://[::1]',
    'http://[fc00::1]',
    'http://[fdff::1]',
    'http://[fe80::1]',
    'http://[febf::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::ffff:192.168.1.1]',
    'garbage',
  ])('blocks %s', (url) => {
    expect(isBlockedFetchUrl(url)).toBe(true)
  })

  it.each([
    'https://example.com',
    'https://A.Example.COM.',
    'http://8.8.8.8',
    'http://100.64.0.1',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://[2001:4860:4860::8888]',
    'http://[::ffff:8.8.8.8]',
  ])('allows %s', (url) => {
    expect(isBlockedFetchUrl(url)).toBe(false)
  })

  it('uses the same literal IP ranges for DNS results, without widening to CGNAT', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:7f00:1', 'fe80::1', 'not-an-ip'])
      expect(isBlockedFetchAddress(address)).toBe(true)
    for (const address of ['8.8.8.8', '100.64.1.1', '2001:4860::8888', '::ffff:808:808'])
      expect(isBlockedFetchAddress(address)).toBe(false)
    expect(hostOfUrl('https://A.Example.COM./path')).toBe('a.example.com')
    expect(hostOfUrl('https://sub.a.example.com')).not.toBe(hostOfUrl('https://a.example.com'))
  })
})
