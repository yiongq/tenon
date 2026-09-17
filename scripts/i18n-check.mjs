#!/usr/bin/env node
// pnpm i18n:check — zero deps. Every locale must carry exactly the keys of the base
// locale (and, with --strict-args, the same ICU argument names).
// Usage: node scripts/i18n-check.mjs <localesDir> [--strict-args]
// Exit: 0 ok · 1 parity problems · 2 structural/JSON error.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const STRICT_ARGS = args.includes('--strict-args')
const ROOT = resolve(args.find((a) => !a.startsWith('--')) ?? 'apps/desktop/src/i18n/locales')
const BASE = 'en'
const fail = (msg) => {
  console.error(`i18n:check: ${msg}`)
  process.exit(2)
}

const flatten = (obj, prefix = '', out = new Map()) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.set(key, v)
  }
  return out
}

const placeholders = (s) =>
  typeof s === 'string'
    ? new Set([...s.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*[,}]/g)].map((m) => m[1]))
    : new Set()

let locales
try {
  locales = readdirSync(ROOT)
    .filter((d) => statSync(join(ROOT, d)).isDirectory())
    .toSorted()
} catch (e) {
  fail(`cannot read ${ROOT} — ${e.message}`)
}
if (!locales.includes(BASE)) fail(`missing base locale "${BASE}" in ${ROOT}`)

const index = new Map()
for (const lng of locales) {
  const byNs = new Map()
  for (const f of readdirSync(join(ROOT, lng))
    .filter((name) => name.endsWith('.json'))
    .toSorted()) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(ROOT, lng, f), 'utf8'))
    } catch (e) {
      fail(`${lng}/${f} is not valid JSON — ${e.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${lng}/${f} must be a JSON object`)
    }
    byNs.set(f.slice(0, -5), flatten(parsed))
  }
  index.set(lng, byNs)
}

const problems = []
const baseNs = index.get(BASE)
for (const lng of locales) {
  if (lng === BASE) continue
  const other = index.get(lng)
  for (const ns of [...new Set([...baseNs.keys(), ...other.keys()])].toSorted()) {
    const a = baseNs.get(ns)
    const b = other.get(ns)
    if (!a) {
      problems.push(`extra namespace   ${lng}/${ns}.json (not present in ${BASE})`)
      continue
    }
    if (!b) {
      problems.push(`missing namespace ${lng}/${ns}.json (present in ${BASE})`)
      continue
    }
    for (const k of a.keys()) {
      if (!b.has(k))
        problems.push(`missing key  ${lng}/${ns}.json  ->  "${ns}:${k}"  (present in ${BASE})`)
    }
    for (const k of b.keys()) {
      if (!a.has(k))
        problems.push(`orphan key   ${lng}/${ns}.json  ->  "${ns}:${k}"  (absent in ${BASE})`)
    }
    if (!STRICT_ARGS) continue
    for (const [k, av] of a) {
      if (!b.has(k)) continue
      const want = placeholders(av)
      const got = placeholders(b.get(k))
      const drift = [...want]
        .filter((p) => !got.has(p))
        .map((p) => `-{${p}}`)
        .concat([...got].filter((p) => !want.has(p)).map((p) => `+{${p}}`))
      if (drift.length) {
        problems.push(
          `arg drift    ${lng}/${ns}.json  ->  "${ns}:${k}"  ${drift.toSorted().join(' ')}`,
        )
      }
    }
  }
}

if (problems.length) {
  console.error(`i18n:check FAILED — ${problems.length} problem(s) in ${ROOT}`)
  for (const p of problems.toSorted()) console.error(`  ${p}`)
  process.exit(1)
}
console.log(
  `i18n:check OK — ${locales.join(', ')} agree on every key${STRICT_ARGS ? ' and ICU argument' : ''} (base: ${BASE})`,
)
