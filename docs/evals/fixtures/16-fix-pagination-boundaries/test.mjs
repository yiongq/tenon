import assert from 'node:assert/strict'
import { pages } from './paginate.js'
assert.deepEqual(pages([1, 2, 3, 4], 2), [
  [1, 2],
  [3, 4],
])
assert.deepEqual(pages([], 2), [])
assert.throws(() => pages([1], 0), RangeError)
process.stdout.write('pagination passed\n')
