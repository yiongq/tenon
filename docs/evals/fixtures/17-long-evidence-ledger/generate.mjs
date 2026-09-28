import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('corpus', { recursive: true })
for (let i = 1; i <= 60; i++) {
  const id = String(i).padStart(2, '0')
  const paragraphs = Array.from(
    { length: 180 },
    (_, j) =>
      `Station ${id} observation ${j}: archived measurements are informational; preserve identifiers and do not infer a final approved value from these historical samples.\n`,
  ).join('')
  writeFileSync(`corpus/${id}.txt`, paragraphs + `\nFINAL_APPROVED_CODE=${7000 + i * 13}\n`)
}
process.stdout.write('60 documents generated\n')
