import assert from 'node:assert/strict'
import { cartTotal, receipt } from './src/cart.js'

const tea = { name: 'Tea', price: '3.50', quantity: 2 }
const mug = { name: 'Mug', price: '12.00', quantity: 1 }
const pen = { name: 'Pen', price: '1.05', quantity: 1 }
const pad = { name: 'Pad', price: '2.50', quantity: 2 }

const cases = [
  ['sums the line totals', () => assert.equal(cartTotal([tea, mug]), 1900)],
  ['takes a percent discount off', () => assert.equal(cartTotal([mug], 25), 900)],
  ['rounds half a cent up', () => assert.equal(cartTotal([{ ...pen, price: '0.99' }], 50), 50)],
  [
    'prints a receipt',
    () => assert.equal(receipt([tea, mug]), 'Tea x2  $7.00\nMug x1  $12.00\nTotal  $19.00'),
  ],
  [
    'prints a receipt with a discount',
    () =>
      assert.equal(
        receipt([pen, pad], 10),
        'Pen x1  $1.05\nPad x2  $5.00\nDiscount  10%\nTotal  $5.45',
      ),
  ],
]

let failed = 0
for (const [index, [name, run]] of cases.entries()) {
  try {
    run()
    process.stdout.write(`ok ${index + 1} - ${name}\n`)
  } catch (error) {
    failed += 1
    const detail = String(error instanceof Error ? error.message : error).replace(/^/gm, '  # ')
    process.stdout.write(`not ok ${index + 1} - ${name}\n${detail}\n`)
  }
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`)
process.exitCode = failed === 0 ? 0 : 1
