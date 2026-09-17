#!/usr/bin/env node
// pnpm lint — docs/ux/tokens.md「组件不许写生色」: no colour literals and no Tailwind palette
// classes anywhere in apps/desktop/src except the token sheet itself.
// Exit: 0 ok · 1 findings.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'apps/desktop/src'
const EXEMPT = new Set(['apps/desktop/src/styles/tokens.css'])
const EXT = /\.(ts|tsx|css)$/
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/g
// Tailwind's default palette names plus black/white. `transparent` / `current` are fine.
const PALETTE =
  /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret|divide)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d{1,3})?\b/g

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (EXT.test(name)) yield p
  }
}

const findings = []
for (const file of walk(ROOT)) {
  const rel = relative('.', file)
  if (EXEMPT.has(rel)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    for (const m of code.matchAll(LITERAL)) {
      findings.push(`${rel}:${i + 1}: colour literal "${m[0]}" — use a --t-* token`)
    }
    for (const m of code.matchAll(PALETTE)) {
      findings.push(`${rel}:${i + 1}: palette class "${m[0]}" — use a token-derived utility`)
    }
  })
}

if (findings.length > 0) {
  console.error(`check-colors FAILED — ${findings.length} finding(s)`)
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`check-colors OK — no colour literals or palette classes under ${ROOT}`)
