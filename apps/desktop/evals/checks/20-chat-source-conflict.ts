import { jsonReply } from './task-data.js'
export default jsonReply({
  closedWeekdays: ['Tue'],
  openWeekdays: ['Mon', 'Wed', 'Thu', 'Fri'],
  opens: '10:00',
  closes: '18:00',
  weekend: 'unknown',
})
