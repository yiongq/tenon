import { describe, expect, it } from 'vitest'
import { absolutePath, isAbsolutePath, joinPath } from '../../src/host/path.js'

describe('absolutePath', () => {
  it('accepts POSIX, Windows drive and UNC paths', () => {
    expect(isAbsolutePath('/usr/bin/node')).toBe(true)
    expect(isAbsolutePath('C:\\Program Files\\node.exe')).toBe(true)
    expect(isAbsolutePath('D:/tools/node')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\x')).toBe(true)
  })

  it('rejects relative paths', () => {
    for (const p of ['node', './node', '../node', '', 'C:node']) {
      expect(isAbsolutePath(p)).toBe(false)
      expect(() => absolutePath(p)).toThrow(TypeError)
    }
  })
})

describe('joinPath', () => {
  it('joins segments with a single slash', () => {
    const base = absolutePath('/root/')
    expect(joinPath(base, 'a', 'b')).toBe('/root/a/b')
    expect(joinPath(absolutePath('/root'), 'a')).toBe('/root/a')
    expect(joinPath(absolutePath('/'), 'a')).toBe('/a')
  })

  it('drops empty segments and returns the base when there are none', () => {
    expect(joinPath(absolutePath('/root'), '', 'x', '')).toBe('/root/x')
    expect(joinPath(absolutePath('/root/'))).toBe('/root')
  })
})
