import { fetchUsr, formatUser, listUsers } from './users.js'

const id = Number(process.argv[2] ?? 1)
const user = fetchUsr(id)
process.stdout.write(user === null ? `no user ${id}\n` : `${formatUser(user)}\n`)
process.stdout.write(`${listUsers().length} users in the directory\n`)
