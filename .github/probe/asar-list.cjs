'use strict'
// PROBE (probe/packaging, never merged): what is inside an app.asar.
// usage: node asar-list.cjs <@electron/asar dir> <app.asar> <regex for entries to print>
const asar = require(process.argv[2])
const file = process.argv[3]
const pattern = new RegExp(process.argv[4] || 'a^')
const list = asar.listPackage(file, {})
const top = {}
for (const entry of list) {
  const match = /^[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(entry)
  const key = match ? match[1] : 'outside node_modules'
  top[key] = (top[key] || 0) + 1
}
const manifest = JSON.parse(asar.extractFile(file, 'package.json').toString())
process.stdout.write(`entries: ${list.length}\n`)
process.stdout.write(
  `package.json: ${JSON.stringify({
    name: manifest.name,
    productName: manifest.productName,
    version: manifest.version,
    main: manifest.main,
  })}\n`,
)
const biggest = Object.entries(top)
  .toSorted((a, b) => b[1] - a[1])
  .slice(0, 12)
process.stdout.write(`largest modules by entry count: ${JSON.stringify(biggest)}\n`)
const hits = list.filter((entry) => pattern.test(entry))
process.stdout.write(`entries matching ${pattern}: ${hits.length}\n`)
for (const hit of hits.slice(0, 40)) process.stdout.write(`  ${hit}\n`)
