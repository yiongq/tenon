// An in-memory user directory for the demo.
const USERS = new Map([
  [1, { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' }],
  [2, { id: 2, name: 'Alan Turing', email: 'alan@example.com' }],
  [3, { id: 3, name: 'Grace Hopper', email: 'grace@example.com' }],
])

/** One user by id, or null when there is none. */
export function fetchUsr(id) {
  return USERS.get(id) ?? null
}

/** Every user, in id order. */
export function listUsers() {
  return [...USERS.keys()].toSorted((a, b) => a - b).map((id) => fetchUsr(id))
}

/** 'Ada Lovelace <ada@example.com>' */
export function formatUser(user) {
  return `${user.name} <${user.email}>`
}
