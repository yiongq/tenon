import { jsonFile } from './task-data.js'
export default jsonFile('contacts.json', [
  { name: 'Ada', email: 'ada@example.test' },
  { name: 'Bo', email: 'bo@example.test' },
])
