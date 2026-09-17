import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl, isSameDocument } from '../src/main/navigation.js'

describe('isAllowedExternalUrl', () => {
  it('lets only web and mail links reach the OS', () => {
    expect(isAllowedExternalUrl('https://example.com/a?b=1')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(true)
  })

  it('refuses local files, network shares, scripts and junk', () => {
    for (const url of [
      'file:///Applications/Calculator.app',
      'smb://attacker/share',
      'javascript:alert(1)',
      'tenon://open',
      'vscode://file/etc/passwd',
      'not a url',
      '',
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false)
    }
  })
})

describe('isSameDocument', () => {
  const appUrl = 'file:///opt/tenon/out/renderer/index.html'

  it('accepts the app document with a different hash or query', () => {
    expect(isSameDocument(appUrl, appUrl)).toBe(true)
    expect(isSameDocument(`${appUrl}#settings`, appUrl)).toBe(true)
    expect(isSameDocument(`${appUrl}?x=1`, appUrl)).toBe(true)
  })

  it('rejects remote origins and other local files', () => {
    expect(isSameDocument('http://attacker.example/', appUrl)).toBe(false)
    expect(isSameDocument('file:///etc/passwd', appUrl)).toBe(false)
    expect(isSameDocument('garbage', appUrl)).toBe(false)
  })

  it('keeps the dev server on its own origin and path', () => {
    const dev = 'http://localhost:5173/'
    expect(isSameDocument('http://localhost:5173/#x', dev)).toBe(true)
    expect(isSameDocument('http://localhost:5174/', dev)).toBe(false)
    expect(isSameDocument('http://localhost:5173/other.html', dev)).toBe(false)
  })
})
