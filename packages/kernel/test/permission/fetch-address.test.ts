import { describe, expect, it } from 'vitest'
import { isBlockedFetchAddress, isBlockedFetchUrl } from '../../src/permission/fetch-address.js'
import { hostOfUrl } from '../../src/permission/reversibility.js'

describe('WebFetch literal boundary', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://public.example/file',
    'https://u:p@public.example',
    'http://user@public.example',
    'http://:password@public.example',
    'http://localhost',
    'http://LOCALHOST.',
    'http://printer',
    'http://0',
    'http://2130706433',
    'http://0x7f000001',
    'http://127.1',
    'http://0177.0.0.1',
    'http://127.1.2.3',
    'http://127.255.255.254',
    'http://10.1.2.3',
    'http://172.16.1.1',
    'http://172.31.255.255',
    'http://192.168.0.1',
    'http://169.254.1.1',
    'http://100.64.0.1',
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
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://[2001:4860:4860::8888]',
    'http://[::ffff:8.8.8.8]',
  ])('allows %s', (url) => {
    expect(isBlockedFetchUrl(url)).toBe(false)
  })

  it('uses the same literal IP ranges for DNS results, including CGNAT', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '100.64.1.1',
      '::1',
      '::ffff:7f00:1',
      '::ffff:127.8.9.10',
      'fe80::1',
      'not-an-ip',
    ])
      expect(isBlockedFetchAddress(address)).toBe(true)
    for (const address of ['8.8.8.8', '2001:4860::8888', '::ffff:808:808'])
      expect(isBlockedFetchAddress(address)).toBe(false)
    expect(hostOfUrl('https://A.Example.COM./path')).toBe('a.example.com')
    expect(hostOfUrl('https://sub.a.example.com')).not.toBe(hostOfUrl('https://a.example.com'))
  })

  it('04 验收 26: 100.64.0.0/10 is blocked, its neighbours are not', () => {
    const cases = [
      ['100.63.255.255', false],
      ['100.64.0.0', true],
      ['100.64.0.1', true],
      ['100.127.255.255', true],
      ['100.128.0.0', false],
      ['100.128.0.1', false],
      ['::ffff:100.63.255.255', false],
      ['::ffff:100.64.0.0', true],
      ['::ffff:100.127.255.255', true],
      ['::ffff:100.128.0.0', false],
      ['::ffff:643f:ffff', false],
      ['::ffff:6440:0', true],
      ['::ffff:647f:ffff', true],
      ['::ffff:6480:0', false],
    ] as const
    for (const [address, blocked] of cases) {
      expect({ address, blocked: isBlockedFetchAddress(address) }).toEqual({ address, blocked })
      const host = address.includes(':') ? `[${address}]` : address
      expect({ address, blocked: isBlockedFetchUrl(`http://${host}/`) }).toEqual({
        address,
        blocked,
      })
    }
  })

  it('04 不变量 17', () => {
    for (const address of [
      '100.64.0.0',
      '100.64.255.255',
      '100.80.1.2',
      '100.96.128.1',
      '100.127.0.0',
      '100.127.255.255',
      '::ffff:100.96.128.1',
      '::ffff:6460:8001',
      '0:0:0:0:0:ffff:6440:1',
    ])
      expect({ address, blocked: isBlockedFetchAddress(address) }).toEqual({
        address,
        blocked: true,
      })
    for (const address of [
      '100.63.255.255',
      '100.128.0.0',
      '::ffff:100.63.255.255',
      '::ffff:100.128.0.0',
    ])
      expect({ address, blocked: isBlockedFetchAddress(address) }).toEqual({
        address,
        blocked: false,
      })
  })
})
