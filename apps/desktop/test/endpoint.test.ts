/**
 * Where a base URL points (spec 02 §模型选择「数据去向」; A9; 01 修补 6「provider.list」: loopback and
 * private together are the local side). What content already sent to a host counts as: a spelling of
 * this machine read as public would let a later switch to a real public host go unconfirmed.
 */
import { describe, expect, it } from 'vitest'
import { endpointOf, hostOf } from '../src/main/endpoint.js'

describe('endpointOf', () => {
  it('reads the usual loopback, private and public hosts by their spelling', () => {
    expect(endpointOf('http://localhost:11434/v1/')).toEqual({
      host: 'localhost',
      reach: 'loopback',
    })
    expect(endpointOf('http://127.0.0.1:4000')).toEqual({ host: '127.0.0.1', reach: 'loopback' })
    expect(endpointOf('http://[::1]:4000')).toEqual({ host: '::1', reach: 'loopback' })
    expect(endpointOf('http://192.168.1.20:11434/v1/')?.reach).toBe('private')
    expect(endpointOf('http://[fd00::5]/')?.reach).toBe('private')
    expect(endpointOf('http://gpu-box:11434/')?.reach).toBe('private')
    expect(endpointOf('https://open.bigmodel.cn/api/paas/v4/')).toEqual({
      host: 'open.bigmodel.cn',
      reach: 'public',
    })
  })

  it('reads every spelling of this machine as loopback (s19-safety-7)', () => {
    // A connection to the unspecified address reaches this machine: OLLAMA_HOST=0.0.0.0 copied over.
    for (const url of [
      'http://0.0.0.0:11434/v1/',
      'http://0.1.2.3/',
      'http://[::]:11434/',
      'http://localhost.:11434/',
      'http://api.localhost./',
      // IPv4-mapped loopback, which the URL parser writes as `::ffff:7f00:1`.
      'http://[::ffff:127.0.0.1]:11434/',
    ]) {
      expect({ url, reach: endpointOf(url)?.reach }).toEqual({ url, reach: 'loopback' })
    }
    // A mapped private address is private, a mapped public one public.
    expect(endpointOf('http://[::ffff:192.168.1.2]/')?.reach).toBe('private')
    expect(endpointOf('http://[::ffff:8.8.8.8]/')?.reach).toBe('public')
  })

  it('drops the trailing dot of a fully qualified name (s19-safety-6)', () => {
    expect(hostOf('https://ollama.com./v1/')).toBe('ollama.com')
    expect(hostOf('https://api.ollama.com.:443/v1/')).toBe('api.ollama.com')
    expect(endpointOf('https://open.bigmodel.cn./api/paas/v4/')).toEqual({
      host: 'open.bigmodel.cn',
      reach: 'public',
    })
    expect(hostOf('not a url')).toBeNull()
  })
})
