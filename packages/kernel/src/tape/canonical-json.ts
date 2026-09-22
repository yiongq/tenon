/**
 * canonicalJson — the one serialisation the tape stores and hashes.
 *
 * `payload_json` / `meta_json` are hashed as the STORED TEXT (spec 01 §哈希链), so this function
 * is part of the on-disk format rather than a convenience: the same value must produce the same
 * bytes on every machine and in every engine, forever. `JSON.stringify` cannot do that — its key
 * order is insertion order — and neither can a permissive serialiser, because every value this
 * function admits is a value some future reader has to reproduce byte for byte.
 *
 * Accepted: plain object (prototype `Object.prototype` or `null`), array, string, finite number,
 * boolean, null. Everything else throws — including every shape `JSON.stringify` would quietly
 * mangle: `undefined` (dropped), `NaN` / `±Infinity` (turned into `null`), `Date` and anything
 * else carrying `toJSON` (rewritten), `Map` / `Set` / class instances / typed arrays (flattened to
 * `{}`), sparse arrays (holes become `null`), symbol-keyed and non-enumerable own properties
 * (dropped). `-0` serialises as `0`, as it does in JSON.
 *
 * It also refuses what `JSON.stringify` would serialise but not REPRODUCE: an accessor property.
 * Running a getter would make the stored text depend on when it ran — the same value could serialise
 * two ways, so `content_hash` as written would not equal `content_hash` as verified — and a throwing
 * getter would leave this module as somebody else's error class carrying its own message. No own
 * property is ever read through a `[key]` access here; every read goes through its descriptor.
 *
 * Key order is UTF-16 code unit order: the default `Array.prototype.sort()` comparison, which
 * compares code units numerically. This is NOT code point order — an astral character (lead
 * surrogate 0xD800–0xDBFF) sorts before U+E000–U+FFFF. Either order would do; this one is the
 * cheap one to write down, and any language that compares UTF-16 code units reproduces it.
 */

/**
 * Thrown for every rejected value, including a cycle. Named so a store can map it: nothing else
 * ever leaves this module, so a caller that catches this class has classified the failure.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

/**
 * Nesting cap. A cycle is caught by the ancestor set, so this is only about depth: without it a
 * deep-but-finite value throws a `RangeError` from the engine instead of a named error. Payloads
 * are messages and tool arguments; 100 is far above anything they need, and raising it later
 * only ever accepts more.
 */
export const CANONICAL_JSON_MAX_DEPTH = 100

export function canonicalJson(value: unknown): string {
  return encode(value, '$', 0, new Set<object>())
}

function reject(path: string, reason: string): never {
  throw new CanonicalJsonError(`canonicalJson: ${path} ${reason}`)
}

/**
 * Reads one own property WITHOUT running user code. An accessor is rejected rather than called: a
 * getter makes the stored text depend on when it ran (the same value would serialise differently on
 * a second call), and a throwing getter would escape this module as somebody else's error class.
 */
function ownDataValue(target: object, key: string | number, at: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor === undefined) reject(at, 'is not an own property')
  if (!('value' in descriptor)) {
    reject(at, 'is an accessor property; its text would depend on when the getter ran')
  }
  return descriptor.value as unknown
}

function encode(value: unknown, path: string, depth: number, ancestors: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      // The one place we lean on JSON.stringify: ECMA-262 fixes its escaping, including the
      // well-formed \udXXX escapes for lone surrogates, so it is deterministic by spec.
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) reject(path, `is ${String(value)}, which JSON cannot represent`)
      // String(-0) is '0', so -0 and 0 serialise alike, as they do in JSON.
      return String(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'undefined':
      reject(path, 'is undefined; a fact records absence with null, never by omission')
    case 'bigint':
      reject(path, 'is a bigint; integers cross as safe numbers')
    case 'function':
      reject(path, 'is a function')
    case 'symbol':
      reject(path, 'is a symbol')
    default:
      return encodeObject(value as object, path, depth, ancestors)
  }
}

function encodeObject(value: object, path: string, depth: number, ancestors: Set<object>): string {
  if (ancestors.has(value)) reject(path, 'closes a cycle')
  if (depth >= CANONICAL_JSON_MAX_DEPTH) {
    reject(path, `is nested deeper than ${CANONICAL_JSON_MAX_DEPTH} levels`)
  }
  // `toJSON` anywhere on the value or its prototype means JSON.stringify and this function would
  // disagree about what the value is. Refuse rather than pick a winner. `in` never runs a getter, so
  // an accessor named toJSON is caught here without being called.
  if ('toJSON' in value) reject(path, 'carries a toJSON method')
  if (Object.getOwnPropertySymbols(value).length > 0) reject(path, 'has symbol-keyed properties')

  ancestors.add(value)
  try {
    return Array.isArray(value)
      ? encodeArray(value as readonly unknown[], path, depth, ancestors)
      : encodePlainObject(value, path, depth, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function encodeArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    reject(path, 'is an Array subclass, not a plain array')
  }
  // Own names are the indices plus 'length'; anything else is data JSON would drop.
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    reject(path, 'is a sparse array or carries extra own properties')
  }
  const parts: string[] = []
  for (let i = 0; i < value.length; i += 1) {
    const at = `${path}[${i}]`
    if (!Object.hasOwn(value, i)) reject(at, 'is a hole in a sparse array')
    parts.push(encode(ownDataValue(value, i, at), at, depth + 1, ancestors))
  }
  return `[${parts.join(',')}]`
}

function encodePlainObject(
  value: object,
  path: string,
  depth: number,
  ancestors: Set<object>,
): string {
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    reject(path, 'is not a plain object (Date, Map, typed array, class instance, …)')
  }
  const keys = Object.keys(value)
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    reject(path, 'has non-enumerable own properties, which JSON would drop')
  }
  // UTF-16 code unit order — see the module comment.
  keys.sort()
  const parts: string[] = []
  for (const key of keys) {
    const at = `${path}.${key}`
    parts.push(
      `${JSON.stringify(key)}:${encode(ownDataValue(value, key, at), at, depth + 1, ancestors)}`,
    )
  }
  return `{${parts.join(',')}}`
}
