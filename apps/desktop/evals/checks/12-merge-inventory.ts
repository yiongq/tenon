import { jsonFile } from './task-data.js'
export default jsonFile('inventory.json', [
  { sku: 'A', qty: 7 },
  { sku: 'B', qty: 2 },
  { sku: 'C', qty: 5 },
])
