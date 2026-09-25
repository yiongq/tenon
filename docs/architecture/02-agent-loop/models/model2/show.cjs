// Prints a model2 result file: node show.cjs ./out.json
const o = require(require('node:path').resolve(process.argv[2]))
const out = (line) => process.stdout.write(line + '\n')
out(`${o.depth} ${o.states} ${o.transitions}`)
for (const v of o.violations) out(`V ${v.tag} | ${v.note}\n    ${v.trace.join(' → ')}`)
for (const v of o.undetermined)
  out(`U ${v.tag} | ${v.note.slice(0, 140)}\n    ${v.trace.join(' → ')}`)
