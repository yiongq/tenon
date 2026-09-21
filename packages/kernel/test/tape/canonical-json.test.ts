import { describe, expect, it } from 'vitest'
import {
  CANONICAL_JSON_MAX_DEPTH,
  CanonicalJsonError,
  canonicalJson,
} from '../../src/tape/canonical-json.js'

// Built with code-point calls rather than written as literals: the formatter folds \uXXXX escapes
// into the characters themselves, which would leave invisible (or NUL) bytes in this source.
const ASTRAL = String.fromCodePoint(0x1f600) // 😀 — surrogate pair 0xD83D 0xDE00
const PRIVATE_USE = String.fromCharCode(0xe000) // above the surrogate block by code POINT
const LONE_SURROGATE = String.fromCharCode(0xd800)
const NUL = String.fromCharCode(0)

describe('canonicalJson · key order', () => {
  it('sorts keys and emits no insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ z: [1, 2], y: { d: 1, c: 2 } })).toBe('{"y":{"c":2,"d":1},"z":[1,2]}')
  })

  it('does not depend on insertion order', () => {
    const forwards: Record<string, unknown> = {}
    forwards['a'] = 1
    forwards['m'] = { x: 1, y: 2 }
    forwards['z'] = [1, { b: 2, a: 3 }]
    const backwards: Record<string, unknown> = {}
    backwards['z'] = [1, { a: 3, b: 2 }]
    backwards['m'] = { y: 2, x: 1 }
    backwards['a'] = 1
    expect(canonicalJson(backwards)).toBe(canonicalJson(forwards))
    expect(canonicalJson(forwards)).toBe(canonicalJson(forwards))
  })

  it('orders by UTF-16 code unit, not by code point', () => {
    // U+1F600's lead code unit is below U+E000, so it sorts FIRST here; code point order would put
    // it last. This assertion is what pins the documented order.
    const json = canonicalJson({ [ASTRAL]: 1, [PRIVATE_USE]: 2 })
    expect(json).toBe(`{${JSON.stringify(ASTRAL)}:1,${JSON.stringify(PRIVATE_USE)}:2}`)
    expect(Object.keys(JSON.parse(json))).toEqual([ASTRAL, PRIVATE_USE])
  })

  it('orders by code unit for ASCII too, so shorter keys and uppercase come first', () => {
    expect(canonicalJson({ b: 0, B: 0, a: 0, A: 0, '': 0, '10': 0, '2': 0 })).toBe(
      '{"":0,"10":0,"2":0,"A":0,"B":0,"a":0,"b":0}',
    )
  })
})

describe('canonicalJson · scalars', () => {
  it('writes numbers the way JSON does, with -0 as 0', () => {
    expect(canonicalJson(0)).toBe('0')
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}')
    expect(canonicalJson(1.5)).toBe('1.5')
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
  })

  it('escapes strings deterministically, including lone surrogates', () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(canonicalJson(`\n\t${NUL}`)).toBe('"\\n\\t\\u0000"')
    expect(canonicalJson(LONE_SURROGATE)).toBe('"\\ud800"')
    expect(canonicalJson('你好 😀')).toBe('"你好 😀"')
  })

  it('passes booleans, null and empty containers through', () => {
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(false)).toBe('false')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson(Object.create(null) as object)).toBe('{}')
  })
})

describe('canonicalJson · rejections', () => {
  class Point {
    x = 1
  }
  class Subarray extends Array {}
  const nonEnumerable = {}
  Object.defineProperty(nonEnumerable, 'hidden', { value: 1, enumerable: false })
  const symbolKeyed = { a: 1, [Symbol('s')]: 2 }
  const sparse = [1, 2, 3]
  delete sparse[1]
  const extraProps: unknown[] = [1]
  ;(extraProps as unknown as Record<string, unknown>)['note'] = 'x'

  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['undefined', undefined, /undefined/],
    ['NaN', Number.NaN, /NaN/],
    ['Infinity', Number.POSITIVE_INFINITY, /Infinity/],
    ['-Infinity', Number.NEGATIVE_INFINITY, /Infinity/],
    ['bigint', 1n, /bigint/],
    ['function', () => 1, /function/],
    ['symbol', Symbol('s'), /symbol/],
    ['undefined as a property value', { a: undefined }, /\$\.a is undefined/],
    ['undefined as an array element', [undefined], /\$\[0\] is undefined/],
    ['NaN nested in an array', { a: [1, Number.NaN] }, /\$\.a\[1\]/],
    ['a Date', new Date(0), /toJSON/],
    ['a Map', new Map([['a', 1]]), /plain object/],
    ['a Set', new Set([1]), /plain object/],
    ['a RegExp', /x/, /plain object/],
    ['a typed array', new Uint8Array([1, 2]), /plain object/],
    ['a class instance', new Point(), /plain object/],
    ['a boxed string', Object('a') as object, /plain object/],
    ['an Array subclass', new Subarray(), /subclass/],
    ['an object with toJSON', { toJSON: () => 1 }, /toJSON/],
    ['a symbol-keyed object', symbolKeyed, /symbol-keyed/],
    ['a non-enumerable own property', nonEnumerable, /non-enumerable/],
    ['a sparse array', sparse, /sparse/],
    ['an array with extra own properties', extraProps, /sparse|extra/],
  ]

  for (const [label, value, message] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError)
      expect(() => canonicalJson(value)).toThrow(message)
    })
  }

  it('names the path of the offending value', () => {
    expect(() => canonicalJson({ a: { b: [{ c: undefined }] } })).toThrow('$.a.b[0].c')
  })
})

/**
 * A getter would make the stored text depend on WHEN it ran, and `content_hash` is computed over the
 * text as written and verified over the text as read — so a getter is the one rejection that is about
 * the on-disk format rather than about JSON. A getter is also user code: it must not be able to throw
 * its own error class, with its own message, out of this module.
 */
describe('canonicalJson · accessors are never run', () => {
  it('rejects a getter rather than calling it twice with two different answers', () => {
    let calls = 0
    const counting = {
      messageId: 'x',
      get revision() {
        calls += 1
        return calls
      },
    }
    expect(() => canonicalJson(counting)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(counting)).toThrow(/accessor/)
    expect(calls).toBe(0)
  })

  it('does not let a throwing getter escape as a foreign error class', () => {
    const smuggler = {
      get secret(): string {
        throw new TypeError('secrets in the message')
      },
    }
    expect(() => canonicalJson(smuggler)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(smuggler)).not.toThrow(/secrets in the message/)
  })

  it('rejects an accessor at an array index too', () => {
    const list = [1, 2]
    Object.defineProperty(list, 1, {
      get() {
        throw new Error('boom from array getter')
      },
      enumerable: true,
      configurable: true,
    })
    expect(() => canonicalJson(list)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(list)).toThrow(/accessor/)
  })

  it('rejects a toJSON accessor without reading it', () => {
    let read = 0
    const value = {
      get toJSON() {
        read += 1
        throw new TypeError('secrets while reading toJSON')
      },
    }
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(value)).toThrow(/toJSON/)
    expect(read).toBe(0)
  })
})

const nest = (levels: number): unknown => {
  let value: unknown = 1
  for (let i = 0; i < levels; i += 1) value = { a: value }
  return value
}

describe('canonicalJson · cycles and depth', () => {
  it('throws a named error on a self-reference instead of overflowing the stack', () => {
    const self: Record<string, unknown> = {}
    self['me'] = self
    expect(() => canonicalJson(self)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(self)).toThrow(/cycle/)
  })

  it('throws on a mutual cycle and on a cycle through an array', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { a }
    a['b'] = b
    expect(() => canonicalJson(a)).toThrow(/cycle/)
    const list: unknown[] = []
    list.push(list)
    expect(() => canonicalJson(list)).toThrow(/cycle/)
  })

  it('accepts a shared reference that is not a cycle', () => {
    const shared = { a: 1 }
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}')
    expect(canonicalJson([shared, shared])).toBe('[{"a":1},{"a":1}]')
  })

  it('rejects nesting past the documented cap, one level below it still works', () => {
    expect(canonicalJson(nest(CANONICAL_JSON_MAX_DEPTH))).toContain('"a"')
    expect(() => canonicalJson(nest(CANONICAL_JSON_MAX_DEPTH + 1))).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(nest(CANONICAL_JSON_MAX_DEPTH + 1))).toThrow(/nested deeper/)
  })
})
