/** Step 33 old-66: mutate only a closed test build, then restore its exact bytes in finally. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const CHANGED_TOOL_SUFFIX = ' TENON_OFFICIAL_RESTART_DESCRIPTION_PROBE.'
export function changeReadDescription(): () => void {
  const file = resolve(process.cwd(), 'out/main/index.js')
  const original = readFileSync(file)
  const digest = createHash('sha256').update(original).digest('hex')
  const needle = 'Reads a text file from the local filesystem.'
  const source = original.toString('utf8')
  if (source.split(needle).length !== 2)
    throw new Error('Expected exactly one built Read description')
  writeFileSync(file, source.replace(needle, needle + CHANGED_TOOL_SUFFIX))
  return () => {
    writeFileSync(file, original)
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) {
      throw new Error('Failed to restore the exact desktop build bytes')
    }
  }
}
