#!/usr/bin/env node
// pnpm lint — spec「国际化」: user-visible copy comes from the catalogue via t(). oxlint's
// react/jsx-no-literals covers JSX children in the renderer; this covers what it cannot:
// native-UI fields in the main process (menus, dialogs, notifications, tray) and literal
// accessibility / placeholder props in the renderer.
// Exit: 0 ok · 1 findings.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// `(?<!\.)`: `error.message : 'x'` in a ternary is a property read, not an object-literal key.
const MAIN_FIELDS =
  /(?<!\.)\b(label|sublabel|title|message|detail|toolTip|placeholder|checkboxLabel|buttonLabel)\s*:\s*(['"`])((?:(?!\2).)+)\2/g
const MAIN_BUTTONS = /\bbuttons\s*:\s*\[[^\]]*(['"`])(?:(?!\1).)+\1/g
const JSX_PROPS = /\b(aria-label|aria-description|placeholder|title|alt)=(["'])((?:(?!\2).)+)\2/g

function* walk(dir, ext) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p, ext)
    else if (ext.test(name)) yield p
  }
}

const strip = (line) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
const findings = []

for (const file of walk('apps/desktop/src/main', /\.ts$/)) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const code = strip(line)
      for (const m of code.matchAll(MAIN_FIELDS)) {
        findings.push(`${relative('.', file)}:${i + 1}: ${m[1]}: "${m[3]}" — use t()`)
      }
      if (MAIN_BUTTONS.test(code)) {
        findings.push(`${relative('.', file)}:${i + 1}: buttons: [...] with literal copy — use t()`)
      }
      MAIN_BUTTONS.lastIndex = 0
    })
}

for (const file of walk('apps/desktop/src/renderer/src', /\.tsx$/)) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const m of strip(line).matchAll(JSX_PROPS)) {
        findings.push(`${relative('.', file)}:${i + 1}: ${m[1]}="${m[3]}" — use t()`)
      }
    })
}

if (findings.length > 0) {
  console.error(`check-copy FAILED — ${findings.length} literal(s) outside the catalogue`)
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}
console.log('check-copy OK — main-process UI fields and renderer text props all go through t()')
