'use strict'
const M = require('./model.cjs')

const out = (line) => process.stdout.write(line + '\n')
const SC = {
  idle: { budget: 3 },
  idleLeftover: {
    budget: 3,
    init: (s) => {
      s.seq = 1
      s.queue = [{ q: 'q0', seq: 1, urgent: false, m: 'm0', owed: false }]
      s.issued = [{ m: 'm0', urgent: false }]
      s.mstat = { m0: 'queued' }
      s.tape.last = 'provider-error'
    },
  },
  idleConfirm: {
    budget: 3,
    init: (s) => {
      s.confirmNeeded = true
    },
  },
  idleMissingKey: {
    budget: 3,
    init: (s) => {
      s.keyMissing = true
    },
  },
  streaming: {
    budget: 3,
    init: (s) => {
      s.leases = { L0: { aborted: null, owner: 'run:r0', stopHit: false } }
      s.runs = {
        r0: {
          sess: 'R',
          lease: 'L0',
          st: 'streaming',
          cause: 'user-message',
          pausedRun: null,
          reason: null,
          batchDone: false,
          own: true,
        },
      }
      s.tape.last = 'running'
    },
  },
  pausedApproval: {
    budget: 3,
    init: (s) => {
      s.tape.last = 'paused'
      s.tape.pending = { sess: 'R', kind: 'approval', pausedRun: 'rP' }
    },
  },
  pausedApprovalConfirm: {
    budget: 3,
    init: (s) => {
      s.confirmNeeded = true
      s.tape.last = 'paused'
      s.tape.pending = { sess: 'R', kind: 'approval', pausedRun: 'rP' }
    },
  },
  pausedQuestion: {
    budget: 3,
    init: (s) => {
      s.tape.last = 'paused'
      s.tape.pending = { sess: 'R', kind: 'question', pausedRun: 'rP' }
    },
  },
  childPending: {
    budget: 3,
    init: (s) => {
      s.tape.last = 'paused'
      s.tape.parentWaiting = true
      s.tape.pending = { sess: 'C', kind: 'approval', pausedRun: 'rC' }
    },
  },
  childOwnLease: {
    budget: 3,
    init: (s) => {
      s.tape.last = 'paused'
      s.tape.parentWaiting = true
      s.leases = { L0: { aborted: null, owner: 'run:r0', stopHit: false } }
      s.runs = {
        r0: {
          sess: 'C',
          lease: 'L0',
          st: 'streaming',
          cause: 'resume',
          pausedRun: null,
          reason: null,
          batchDone: true,
          own: true,
        },
      }
    },
  },
  resumableRoot: {
    budget: 3,
    init: (s) => {
      s.crashed = 1
      s.tape.last = 'paused'
      s.tape.resumable = { sess: 'R', pausedRun: 'rP' }
      s.rset = [{ sess: 'R', pausedRun: 'rP' }]
    },
  },
  resumableChild: {
    budget: 3,
    init: (s) => {
      s.crashed = 1
      s.tape.last = 'paused'
      s.tape.parentWaiting = true
      s.tape.resumable = { sess: 'C', pausedRun: 'rC' }
      s.rset = [{ sess: 'C', pausedRun: 'rC' }]
    },
  },
  truncated: {
    budget: 3,
    init: (s) => {
      s.tape.last = 'output-truncated'
    },
  },
}
const which = process.argv[2] || 'all'
const budget = +(process.argv[3] || 3)
const maxStates = +(process.env.MAX_STATES || 400000)
const findings = new Map()
let total = 0,
  maxDepth = 0
for (const [name, sc] of Object.entries(SC)) {
  if (which !== 'all' && which !== name) continue
  sc.budget = budget
  const s0 = M.initial(sc)
  const seen = new Map([[M.key(s0), true]])
  let frontier = [{ s: s0, path: [] }]
  let n = 1
  while (frontier.length && n < maxStates) {
    const next = []
    for (const { s, path } of frontier) {
      const acts = [...M.userActions(s), ...M.envActions(s)]
      // under KEYCHAIN_HANG a prebuild legitimately waits on the keychain; only a wait that survives an abort is a deadlock
      if (
        !acts.length &&
        !M.quiescent(s) &&
        (!M.READ.keychainHang ||
          (s.app === 'normal' && Object.values(s.leases).some((l) => l.aborted)))
      )
        record(name, 'VIOLATION deadlock: not quiescent and nothing can move', path, s)
      if (M.quiescent(s)) for (const v of M.checkQuiescent(s)) record(name, v, path, s)
      for (const [label] of acts) {
        const t = M.clone(s)
        t.trace = []
        t.undef = []
        // re-bind closures on the clone
        const again = [...M.userActions(t), ...M.envActions(t)].find(([l]) => l === label)
        again[1]()
        const p2 = path.concat([label, ...t.trace])
        for (const v of M.check(t)) record(name, v, p2, t)
        const k = M.key(t)
        if (seen.has(k)) continue
        seen.set(k, true)
        n++
        next.push({ s: t, path: p2 })
      }
    }
    if (next.length)
      maxDepth = Math.max(maxDepth, next[0].path.filter((x) => !x.startsWith('  ')).length)
    frontier = next
  }
  total += n
  out(`# ${name}: ${n} states${n >= maxStates ? ' (capped)' : ''}`)
}
function record(sc, v, path) {
  const k = v.replace(/\b[cLrqm]\d+\b/g, '#')
  const cur = findings.get(k)
  const steps = path.filter((x) => !x.startsWith('  ')).length
  if (!cur || steps < cur.steps) findings.set(k, { sc, v, path, steps })
}
out(`total states ${total}, max depth ${maxDepth}, reading=${JSON.stringify(M.READ)}\n`)
for (const f of [...findings.values()].toSorted((a, b) => a.steps - b.steps)) {
  out(`== [${f.sc}] ${f.v}\n   trace (${f.steps} steps):`)
  for (const p of f.path) out('     ' + p)
}
