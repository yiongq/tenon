// Executable model of spec 02 §主进程与 kernel 的循环接口 (root session, leases, mailbox, queue, held, stop, quit).
// Encodes the rules AS WRITTEN (spec.md:335-433, 1444-1465, 1598-1666, 1687-1775, 2535-2588).
// Round 3 (R3): lease never changes hands; entry begins only with no live lease and an empty mailbox;
// while a command holds the lease pre-Run the mailbox runs only it (and stop); Run write tasks check the signal.
// Plain Node, no deps. Usage: node run.cjs [scenario|all] [budget]
'use strict'

// ---------------------------------------------------------------- utilities
const clone = (x) => JSON.parse(JSON.stringify(x))
const key = (s) => JSON.stringify({ ...s, trace: undefined, undef: undefined })

// Reading switches: where the text allows more than one reading, the model can run each.
const READ = {
  // :418 — a send meeting a lease that is aborted but held by a prebuilding command (not a Run):
  // 'prebuild' = "别的命令已 begin、还在预建" (plain enqueue); 'aborted' = "已中止、未收完的 Run" (urgent)
  abortedPrebuildAs: process.env.ABORTED_PREBUILD_AS || 'prebuild',
  // :425 — are run_terminal commit and take/finish one mailbox task? 'one' | 'split'
  runEndTask: process.env.RUN_END_TASK || 'one',
  // R4 :422 — prebuild's keychain may never answer; the text now races lease.signal (an aborted prebuild stops waiting)
  keychainHang: !!process.env.KEYCHAIN_HANG,
  // R4 :428 — demo only: drop the child re-check after run_terminal (the pre-R4 text)
  childNoRecheck: !!process.env.CHILD_NO_RECHECK,
  // R5 :428 — a user-stop landing during the paused run_terminal append / take closes the card in the run-end task
  // (暂停中停止). PAUSED_NO_RECHECK=1 demos the pre-R5 text (only the queue take is recomputed; the stop is swallowed)
  fixPausedStop: !process.env.PAUSED_NO_RECHECK,
  // R6 :426 :428 RunLease.stopRequested — any abort('user-stop') sets it, even on a lease already aborted by quit/close-window;
  // the before-append and run-end branches close like a stop when it is set (stopHit here). PRE_R6_STOP=1 demos the pre-R6 text.
  lateStop: !process.env.PRE_R6_STOP,
}

function initial(sc) {
  const s = {
    app: 'normal',
    budget: 0,
    crashed: 0,
    ctr: 1,
    seq: 0,
    keyMissing: false,
    confirmNeeded: false,
    leases: {}, // id -> {aborted, owner, stopHit}
    cmds: {}, // id -> command state
    mb: [], // mailbox tasks
    runs: {}, // id -> {sess, lease, st, cause, pausedRun, reason, batchDone, parent}
    queue: [], // [{q, seq, urgent, m, owed}]
    held: null, // {q|null}
    rset: [], // kernel resumable set: [{sess, pausedRun}]
    tape: {
      last: 'completed',
      pending: null,
      parentWaiting: false,
      resumable: null,
      resumeCount: {},
      msgs: [],
      sessionChoice: false,
      stopClosures: 0,
    },
    issued: [], // [{m, urgent}] in user order
    mstat: {}, // m -> status
    undef: [],
    trace: [],
  }
  Object.assign(s, sc.init ? sc.init(s) || {} : {})
  s.budget = sc.budget
  if (s.tape.pending) s.tape.pending.id = 'p0'
  s.stopRecs = [] // INV: cards / resumable items that a stop returning stopped:true promised to close
  s.quitCards = null // INV B4
  s.closes = 0
  return s
}
const nid = (s, p) => p + s.ctr++

// ---------------------------------------------------------------- queries
const liveLease = (s) => Object.keys(s.leases)[0] || null // model is one root; >1 caught by invariant
const leaseOwnerRun = (s, L) => {
  const o = s.leases[L] && s.leases[L].owner
  return o && o.startsWith('run:') ? o.slice(4) : null
}
const leaseOwnerCmd = (s, L) => {
  const o = s.leases[L] && s.leases[L].owner
  return o && o.startsWith('cmd:') ? o.slice(4) : null
}
const activeRuns = (s) => Object.entries(s.runs).filter(([, r]) => r.st !== 'ended')
function tapeResumable(s) {
  const r = s.tape.resumable
  return r && !s.tape.resumeCount[r.pausedRun] ? r : null
}
function busy(s, selfId) {
  // :418 "判定用的「进行中」"
  for (const [, r] of activeRuns(s)) {
    const l = s.leases[r.lease]
    if (!l) continue
    return l.aborted ? 'aborted-run' : 'running'
  }
  for (const [L] of Object.entries(s.leases)) {
    const c = leaseOwnerCmd(s, L)
    if (c && c !== selfId)
      s.undef.push(
        'VIOLATION command judged while another command holds the lease pre-Run (R3 blocks the mailbox)',
      )
  }
  return null
}

// ---------------------------------------------------------------- lease primitives
function begin(s, owner) {
  if (s.app === 'quitting') return null // { refused: 'shutting-down' }
  const L = nid(s, 'L')
  s.leases[L] = { aborted: null, owner, stopHit: false }
  return L
}
function finish(s, L) {
  delete s.leases[L]
}
function abortLease(s, L, cause, byStop) {
  const l = s.leases[L]
  if (!l) return false
  if (!l.aborted) l.aborted = cause
  if (byStop) l.stopHit = true
  return true
}
// :417 「租约」: a command at its turn that must open a Run and has no lease
function acquire(s, c) {
  if (c.lease && s.leases[c.lease]) return c.lease
  const L = liveLease(s)
  if (!L) {
    const n = begin(s, 'cmd:' + c.id)
    if (n) c.lease = n
    return n
  }
  s.undef.push(
    'VIOLATION acquire with a live lease held by someone else (R3: never happens, lease never changes hands)',
  )
  return null
}

// ---------------------------------------------------------------- queue primitives
function enqueue(s, m, urgent, owed) {
  const q = 'q' + m.slice(1)
  s.seq++
  s.queue.push({ q, seq: s.seq, urgent, m, owed })
  s.mstat[m] = 'queued'
  return q
}
function take(s, o) {
  let out
  if (o.q) out = s.queue.filter((x) => x.q === o.q)
  else
    out = s.queue.filter((x) => (o.upTo == null || x.seq <= o.upTo) && (!o.urgentOnly || x.urgent))
  s.queue = s.queue.filter((x) => !out.includes(x))
  for (const x of out) s.mstat[x.m] = 'taken'
  return out
}
function restore(s, items, patch) {
  for (const x of items) {
    s.queue.push({ ...x, ...patch })
    s.mstat[x.m] = 'queued'
  }
  s.queue.sort((a, b) => a.seq - b.seq)
}
function writeMsgs(s, ms) {
  if (ms.length && (s.tape.pending || s.tape.parentWaiting))
    s.undef.push(
      'VIOLATION message/user ' +
        ms.join(',') +
        ' written while a card waits (pending=' +
        JSON.stringify(s.tape.pending) +
        ', parentWaiting=' +
        s.tape.parentWaiting +
        ')',
    )
  if (ms.length && s.queue.some((x) => x.urgent))
    s.undef.push(
      'VIOLATION urgent item ' +
        s.queue.filter((x) => x.urgent).map((x) => x.q) +
        ' overtaken: ' +
        ms.join(',') +
        ' written while it stays queued',
    )
  for (const m of ms) {
    if (s.tape.msgs.includes(m)) s.undef.push('VIOLATION duplicate message/user ' + m)
    s.tape.msgs.push(m)
    s.mstat[m] = 'written'
  }
}

// ---------------------------------------------------------------- run primitives
function openRun(s, L, sess, cause, pausedRun) {
  if (
    (cause === 'user-message' || cause === 'continue') &&
    s.confirmNeeded &&
    !s.tape.sessionChoice
  )
    s.undef.push('VIOLATION D3 ' + cause + ' Run opened to an unconfirmed host')
  if (cause !== 'resume' && tapeResumable(s))
    s.undef.push(
      'VIOLATION ' + cause + ' Run opened while the Tape has a resumable item (resume bypassed)',
    )
  if (L && s.leases[L] && s.leases[L].aborted)
    s.undef.push('VIOLATION Run opened on an aborted lease ' + L + ' (' + s.leases[L].aborted + ')')
  const r = nid(s, 'r')
  s.runs[r] = {
    sess,
    lease: L,
    st: cause === 'resume' ? 'assembling' : 'streaming',
    cause,
    pausedRun: pausedRun || null,
    reason: null,
    batchDone: false,
    own: true,
  }
  if (L) s.leases[L].owner = 'run:' + r
  if (pausedRun) {
    s.tape.resumeCount[pausedRun] = (s.tape.resumeCount[pausedRun] || 0) + 1
    if (s.tape.resumeCount[pausedRun] > 1)
      s.undef.push('VIOLATION two Runs resume the same paused Run ' + pausedRun)
  }
  if (sess === 'R' && (cause === 'user-message' || cause === 'continue')) s.tape.last = 'running'
  if (cause === 'user-message') s.held = null // R3: a new round clears held
  if (pausedRun) s.rset = s.rset.filter((x) => x.pausedRun !== pausedRun) // R3: any run_started{resume} removes the item
  return r
}
function writeStopClosure(s, heldLease) {
  // §答复与投递 :1666 / §每种答复同批写什么 "暂停中停止" and "可续跑的会话里停止"
  const p = s.tape.pending
  if (p) {
    s.tape.pending = null
    s.tape.stopClosures++
    if (p.sess === 'C') s.tape.parentWaiting = false // parent Agent call aborted (stopped)
    return true
  }
  const tr = tapeResumable(s)
  s.rset = s.rset.filter((x) => tr && x.pausedRun === tr.pausedRun) // R3: re-check the Tape
  if (tr) {
    // writes a no-request Run pointing to the paused Run; R3: begins a lease in the mailbox
    const Ls = heldLease || begin(s, 'stoprun')
    if (!Ls) return false
    const pr = tr.pausedRun,
      sess = tr.sess
    s.tape.resumeCount[pr] = (s.tape.resumeCount[pr] || 0) + 1
    if (s.tape.resumeCount[pr] > 1)
      s.undef.push('VIOLATION two Runs resume the same paused Run ' + pr + ' (stop Run)')
    if (sess === 'C') s.tape.parentWaiting = false
    s.rset = []
    s.tape.stopClosures++
    // root last run unchanged for a child; for root it is user-stopped
    if (sess === 'R') s.tape.last = 'user-stopped'
    // Run end: user-stopped takes urgent only (none can exist here), then finish
    const items = take(s, { urgentOnly: true })
    if (items.length) s.undef.push('VIOLATION urgent item existed at stop-on-resumable')
    if (!heldLease) finish(s, Ls)
    return true
  }
  return false
}

// ---------------------------------------------------------------- user actions
function userActions(s) {
  const acts = []
  if (s.budget <= 0 || s.app !== 'normal') return acts
  const L = liveLease(s)
  const seenRun = L ? leaseOwnerRun(s, L) : null
  acts.push(['send', () => cmdEntry(s, { kind: 'send' })])
  if (seenRun)
    acts.push([
      'sendNow(runId=' + seenRun + ')',
      () => cmdEntry(s, { kind: 'send', urgentRun: seenRun, now: true }),
    ])
  for (const it of s.queue) {
    acts.push([
      'queue.send-now(' + it.q + ',runId=' + seenRun + ')',
      () => cmdEntry(s, { kind: 'qsend', q: it.q, urgentRun: seenRun }),
    ])
    acts.push([
      'queue.withdraw(' + it.q + ')',
      () => {
        take(s, { q: it.q })
        s.mstat[it.m] = 'withdrawn'
      },
    ])
  }
  if (s.tape.pending && s.tape.pending.kind === 'approval') {
    acts.push(['answer(allow)', () => cmdEntry(s, { kind: 'answer', allow: true })])
    acts.push(['answer(deny)', () => cmdEntry(s, { kind: 'answer', allow: false })])
  }
  acts.push(['stop', () => stopEntry(s)])
  if (s.tape.last === 'output-truncated')
    acts.push(['continue', () => cmdEntry(s, { kind: 'continue' })])
  acts.push(['approval.resume(open session)', () => cmdEntry(s, { kind: 'resume' })])
  if (s.held)
    acts.push([
      'selectModel',
      () => {
        s.mb.push({ t: 'select' })
      },
    ])
  acts.push(['quit', () => quit(s)])
  if (!s.closes && Object.values(s.leases).some((l) => !l.aborted))
    acts.push(['closeWindow(confirm stop)', () => closeWindow(s)])
  if (!s.crashed) acts.push(['crash+restart+recover', () => crash(s)])
  return acts.map(([n, f]) => [
    n,
    () => {
      s.budget--
      f()
    },
  ])
}

function cmdEntry(s, c) {
  c.id = nid(s, 'c')
  c.lease = null
  c.pre = null
  c.takenOver = false
  if (c.kind === 'send') {
    c.m = nid(s, 'm')
    s.issued.push({ m: c.m, urgent: !!c.now })
    s.mstat[c.m] = 'in-flight'
  }
  s.cmds[c.id] = c
  // R3 :417 look before the first await: begin only if no live lease and no command queued or waiting; resume never at entry
  const pendingCmd = s.mb.some((t) => t.t === 'cmd' || t.t === 'stop' || t.t === 'select')
  if (!liveLease(s) && !pendingCmd && c.kind !== 'resume') {
    const L = begin(s, 'cmd:' + c.id)
    if (!L) {
      c.done = 'refused'
      if (c.m) s.mstat[c.m] = 'refused'
      delete s.cmds[c.id]
      return
    }
    c.lease = L
    // :419 prebuild: send (no lease at entry), continue; not when kernel knows question pending or resumable
    const q = s.tape.pending && s.tape.pending.kind === 'question' && s.tape.pending.sess === 'R'
    const res = s.rset.length > 0
    if ((c.kind === 'send' || c.kind === 'qsend') && !q && !res) {
      c.stage = 'prebuild'
      c.peek = s.seq
      return
    }
    if (c.kind === 'continue') {
      c.stage = 'prebuild'
      c.peek = s.seq
      return
    }
  }
  c.peek = s.seq
  c.stage = 'mb'
  s.mb.push({ t: 'cmd', c: c.id })
}

function stopEntry(s) {
  // :424 有活租约就 abort('user-stop')；没有就排进 mailbox
  const L = liveLease(s)
  if (L) {
    s.held = null
    recStop(s, 'entry', L)
    abortLease(s, L, 'user-stop', true)
    s.trace.push('  stop -> lease ' + L + ' aborted, stopped:true')
    return
  }
  s.stopAsked = (s.stopAsked || []).concat([
    { p: s.tape.pending && s.tape.pending.id, r: tapeResumable(s) && tapeResumable(s).pausedRun },
  ])
  s.mb.push({ t: 'stop' })
}

function recStop(s, via, L) {
  const p = s.tape.pending,
    tr = tapeResumable(s)
  const prior = L && s.leases[L] && s.leases[L].aborted
  if (prior && process.env.SKIP_NOOP_STOP) return
  s.stopRecs.push({
    via: via + (prior ? ',lease already aborted by ' + prior : ''),
    p: p ? p.id : null,
    r: tr ? tr.pausedRun : null,
  })
}
function closeWindow(s) {
  // INV: window close with running() non-empty -> dialog -> stop -> abort('close-window') on this window's leases (one window)
  s.closes++
  for (const L of Object.keys(s.leases)) abortLease(s, L, 'close-window', false)
}
function quit(s) {
  s.quitCards = {
    p: s.tape.pending && s.tape.pending.id,
    r: tapeResumable(s) && tapeResumable(s).pausedRun,
  }
  s.app = 'quitting'
  for (const L of Object.keys(s.leases)) abortLease(s, L, 'quit', false)
}

function crash(s) {
  s.crashed++
  // memory lost
  for (const it of s.queue) s.mstat[it.m] = 'lost-on-exit'
  for (const m of Object.keys(s.mstat))
    if (s.mstat[m] === 'in-flight' || s.mstat[m] === 'taken') s.mstat[m] = 'lost-on-exit'
  // R4: crash between the child's run_terminal and the parent handoff (inside the run-end task) -> recovery row 4 writes it
  const childEndPending = s.mb.some(
    (t) => t.cont && s.runs[t.r] && s.runs[t.r].sess === 'C' && s.runs[t.r].reason !== 'paused',
  )
  s.leases = {}
  s.cmds = {}
  s.mb = []
  s.queue = []
  s.held = null
  s.rset = []
  s.stopRecs = []
  // recovery (a): open Runs get terminal 'recovered' (or paused when only waiting on subagent)
  const hadChildRun = childEndPending || activeRuns(s).some(([, r]) => r.sess === 'C')
  for (const [, r] of activeRuns(s)) {
    r.st = 'ended'
    if (r.sess === 'R') s.tape.last = 'recovered'
  }
  if (hadChildRun) s.tape.parentWaiting = false // uncertain handoff
  s.runs = {}
  s.app = 'normal'
  // step 2 rejudge may tighten the pending approval -> resumable (nondeterminism folded: tighten always here;
  // the untightened case is the plain paused scenario)
  if (s.tape.pending && s.tape.pending.kind === 'approval') {
    s.tape.resumable = { sess: s.tape.pending.sess, pausedRun: s.tape.pending.pausedRun }
    s.tape.pending = null
  }
  const tr = tapeResumable(s)
  if (tr) s.rset = [clone(tr)]
  s.trace.push('  recover(): resumable=' + JSON.stringify(s.rset) + ', no model request')
}

// ---------------------------------------------------------------- environment steps
function envActions(s) {
  const acts = []
  for (const [id, c] of Object.entries(s.cmds)) {
    if (c.stage === 'prebuild') {
      const la = c.lease && s.leases[c.lease] && s.leases[c.lease].aborted
      if (READ.keychainHang && !la) continue // R4: keychain never answers; only an abort releases the prebuild
      acts.push([
        (la ? 'prebuild stops waiting (aborted) ' : 'prebuild done ') + id,
        () => {
          const l = c.lease && s.leases[c.lease]
          c.pre = s.keyMissing
            ? 'missing'
            : s.confirmNeeded && !s.tape.sessionChoice
              ? 'confirm'
              : 'ok'
          if (l && l.aborted) c.pre = 'aborted'
          c.stage = 'mb'
          s.mb.push({ t: 'cmd', c: id })
        },
      ])
    }
  }
  const ti = nextTaskIndex(s)
  if (ti >= 0) acts.push(['mailbox: ' + describeTask(s, s.mb[ti]), () => mailboxStep(s, ti)])
  for (const [id, r] of activeRuns(s)) {
    const l = s.leases[r.lease]
    if (r.st === 'assembling') {
      acts.push([
        'assemble resolves ' + id,
        () => {
          r.st = 'streaming'
        },
      ])
      if (l && l.aborted)
        acts.push([
          'aborted ' + id + ' ends without waiting for keychain',
          () => endRun(s, id, abortReason(l.aborted)),
        ])
    } else if (r.st === 'streaming') {
      if (l && l.aborted) {
        acts.push([id + ' ends (aborted)', () => endRun(s, id, abortReason(l.aborted))])
        continue
      }
      if (!r.batchDone && r.sess === 'R')
        acts.push([
          id + ' reaches batch boundary',
          () => {
            r.batchDone = true
            s.mb.push({ t: 'batch', r: id })
          },
        ])
      acts.push([id + ' ends completed', () => endRun(s, id, 'completed')])
      acts.push([id + ' ends paused(approval)', () => endRun(s, id, 'paused')])
      if (r.sess === 'R')
        acts.push([id + ' ends provider-error', () => endRun(s, id, 'provider-error')])
    }
  }
  return acts
}
const abortReason = (c) =>
  c === 'user-stop' ? 'user-stopped' : c === 'quit' ? 'shutdown-quit' : 'shutdown-close-window'
function endRun(s, id, reason) {
  const r = s.runs[id]
  r.st = 'ending'
  r.reason = reason
  s.mb.push({ t: 'runEnd', r: id })
}
function describeTask(s, t) {
  if (t.t === 'cmd') {
    const c = s.cmds[t.c]
    return c ? c.kind + ' ' + t.c : 'gone ' + t.c
  }
  if (t.t === 'runEnd')
    return 'run_terminal+take+finish ' + t.r + ' (' + (s.runs[t.r] && s.runs[t.r].reason) + ')'
  if (t.t === 'take')
    return (t.cont ? 'run-end continuation (take+finish+begin) ' : 'take+finish (split) ') + t.r
  return t.t + (t.r ? ' ' + t.r : '')
}

// R3: while a command holds the lease and has not opened a Run, the mailbox runs only that command (and stop)
function nextTaskIndex(s) {
  const ci = s.mb.findIndex((t) => t.cont)
  if (ci >= 0) return ci
  const L = liveLease(s)
  const h = L ? leaseOwnerCmd(s, L) : null
  if (!h) return s.mb.length ? 0 : -1
  return s.mb.findIndex(
    (t) =>
      (t.t === 'cmd' && t.c === h) ||
      t.t === 'stop' ||
      t.t === 'runEnd' ||
      t.t === 'batch' ||
      t.t === 'take',
  )
}
function mailboxStep(s, i) {
  const t = s.mb.splice(i || 0, 1)[0]
  if (t.t === 'cmd') return cmdTurn(s, s.cmds[t.c])
  if (t.t === 'stop') return stopTurn(s)
  if (t.t === 'runEnd') return runEndTurn(s, t.r)
  if (t.t === 'take') return runTakeTurn(s, t.r)
  if (t.t === 'batch') return batchTurn(s, t.r)
  if (t.t === 'select') return selectTurn(s)
}

function doneCmd(s, c, status) {
  c.done = status
  if (c.lease && s.leases[c.lease] && leaseOwnerCmd(s, c.lease) === c.id) finish(s, c.lease)
  if (c.m && s.mstat[c.m] === 'in-flight') s.mstat[c.m] = status
  delete s.cmds[c.id]
  s.trace.push('  -> ' + c.id + ' returns ' + status)
}

// :423 登记之后、append 之前被中止
function abortedBeforeAppend(s, c) {
  const cause = s.leases[c.lease].aborted
  if (c.items) restore(s, c.items, { owed: false, urgent: false }) // aborted auto-send / release: items back, urgent cleared (R3)
  // R6 :426 restore first, then look: user-stop, or stopRequested (a user-stop after quit/close-window) counts as user-stop in the whole branch
  const eff =
    cause === 'user-stop' || (READ.lateStop && s.leases[c.lease].stopHit) ? 'user-stop' : cause
  if (eff === 'user-stop') writeStopClosure(s, c.lease)
  // run-ended{runId:null, recorded:false} for send / continue / auto-send
  if (eff === 'user-stop') for (const x of s.queue) if (!x.urgent && !x.afterStop) x.owed = false
  const st =
    c.kind === 'answer'
      ? eff === 'user-stop'
        ? 'already-resolved'
        : 'refused'
      : c.kind === 'resume'
        ? 'UNSPECIFIED(resume return on abort)'
        : 'not-sent:' + (eff === 'user-stop' ? 'stopped' : 'app-exit')
  if (c.kind === 'resume')
    s.undef.push(
      'VIOLATION resume aborted before append (R3: resume begins and appends in one sync segment)',
    )
  doneCmd(s, c, st)
}

function cmdTurn(s, c) {
  if (!c) return
  if (
    c.lease &&
    s.leases[c.lease] &&
    s.leases[c.lease].aborted &&
    leaseOwnerCmd(s, c.lease) === c.id
  )
    return abortedBeforeAppend(s, c)
  if (c.kind === 'auto' || c.kind === 'release') return newRoundTurn(s, c, 'auto')
  if (c.kind === 'answer') return answerTurn(s, c)
  if (c.kind === 'resume') return resumeTurn(s, c)
  if (c.kind === 'continue') return continueTurn(s, c)
  return sendTurn(s, c)
}

function sendTurn(s, c) {
  const p = s.tape.pending
  const b = busy(s, c.id)
  // qsend: item gone -> not-found
  if (c.kind === 'qsend') {
    const it = s.queue.find((x) => x.q === c.q)
    if (!it) return doneCmd(s, c, 'not-found')
    if (c.urgentRun && s.runs[c.urgentRun] && stillRunning(s.runs[c.urgentRun].st)) {
      abortLease(s, s.runs[c.urgentRun].lease, 'user-stop', true)
      if (s.held && s.held.q === c.q) s.held = null // :425 held item taken by 立即发送 clears held
      const got = take(s, { q: c.q })
      restore(s, got, { urgent: true, owed: true })
      markUrgent(s, it.m) // jumps the queue by design
      return doneCmd(s, c, 'queued(urgent)')
    }
    if (b) return doneCmd(s, c, 'queued') // stays where it is
  }
  // 1. question pending -> typed reply
  if (p && p.kind === 'question' && p.sess === 'R' && !b) {
    const L = acquire(s, c)
    if (!L) return doneCmd(s, c, 'refused')
    s.tape.pending = null
    s.mstat[c.m] = 'answered'
    openRun(s, L, 'R', 'resume', p.pausedRun)
    return doneCmd(s, c, 'answered')
  }
  // 2. in progress
  if (b) {
    if (c.urgentRun && s.runs[c.urgentRun] && stillRunning(s.runs[c.urgentRun].st)) {
      abortLease(s, s.runs[c.urgentRun].lease, 'user-stop', true)
      enqueue(s, c.m, true, true)
      markUrgent(s, c.m)
      return doneCmd(s, c, 'queued')
    }
    if (b === 'aborted-run') {
      enqueue(s, c.m, true, true)
      markUrgent(s, c.m)
      return doneCmd(s, c, 'queued')
    }
    // plain enqueue; owed (expects auto-send) unless the thing ahead was already stopped
    enqueue(s, c.m, false, true)
    return doneCmd(s, c, 'queued')
  }
  // 3. resumable (kernel set, re-checked against the Tape — R3)
  {
    const tr = tapeResumable(s)
    s.rset = s.rset.filter((x) => tr && x.pausedRun === tr.pausedRun)
  }
  if (s.rset.length && c.kind === 'send') {
    const L = acquire(s, c)
    if (!L) return doneCmd(s, c, 'refused')
    const it = s.rset[0]
    openResumeRun(s, L, it) // R3: openRun removes the item from the set
    enqueue(s, c.m, false, true)
    return doneCmd(s, c, 'queued')
  }
  // 4/5. pending approval (supersede) or idle -> new round
  return newRoundTurn(s, c, 'send')
}
// R4 :430 「仍在跑」= run_terminal not yet committed (its end task still queued counts)
const stillRunning = (st) => ['streaming', 'assembling', 'ending'].includes(st)
function markUrgent(s, m) {
  const i = s.issued.find((x) => x.m === m)
  if (i) i.urgent = true
}
function openResumeRun(s, L, it) {
  if (it.sess === 'C') {
    openRun(s, L, 'C', 'resume', it.pausedRun)
  } else openRun(s, L, 'R', 'resume', it.pausedRun)
}

function newRoundTurn(s, c, _kind) {
  // needs a prebuild result
  if (!c.pre) {
    const L = acquire(s, c)
    if (!L) return doneCmd(s, c, 'refused')
    c.stage = 'prebuild'
    s.trace.push('  ' + c.id + ' has no prebuild: leaves mailbox to prebuild, re-queues')
    return
  }
  const L0 = acquire(s, c)
  if (!L0) return doneCmd(s, c, 'refused')
  if (c.pre === 'missing') {
    if (c.items) restore(s, c.items, { owed: false, urgent: false })
    for (const x of s.queue) x.owed = false
    return doneCmd(s, c, 'not-sent:config-missing')
  }
  if (c.pre === 'confirm') {
    for (const x of s.queue) x.owed = false
    if (c.items) {
      restore(s, c.items, { owed: false, urgent: false })
      s.held = { q: null }
    } else if (c.kind === 'qsend') {
      s.held = { q: c.q }
      for (const x of s.queue) if (x.q === c.q) x.owed = false
    } else {
      const q = enqueue(s, c.m, false, false)
      s.held = { q }
    }
    return doneCmd(s, c, 'held')
  }
  // ok -> supersede if pending, then new round
  if (s.tape.pending) {
    s.tape.pending = null
    s.tape.parentWaiting = false
  }
  let ms
  if (c.items) ms = c.items.map((x) => x.m)
  else if (c.kind === 'qsend') {
    const it = s.queue.find((x) => x.q === c.q)
    if (!it) return doneCmd(s, c, 'not-found')
    ms = take(s, { upTo: it.seq }).map((x) => x.m)
  } else
    ms = take(s, {})
      .map((x) => x.m)
      .concat([c.m]) // R3: take all queued at the turn
  writeMsgs(s, ms)
  openRun(s, c.lease, 'R', 'user-message')
  c.lease = null
  delete s.cmds[c.id]
  s.trace.push('  -> ' + c.id + ' started new round ' + JSON.stringify(ms))
}

function answerTurn(s, c) {
  const p = s.tape.pending
  if (!p || p.kind !== 'approval') return doneCmd(s, c, 'already-resolved')
  const L = acquire(s, c)
  if (!L) return doneCmd(s, c, 'refused')
  s.tape.pending = null
  if (c.allow || p.sess === 'C') {
    openRun(s, L, p.sess, 'resume', p.pausedRun)
    c.lease = null
    delete s.cmds[c.id]
    s.trace.push('  -> ' + c.id + ' applied, resume Run')
    return
  }
  // root deny: Run with run_started + run_terminal{user-rejected}, no request -> Run 结束 path
  const r = openRun(s, L, 'R', 'resume', p.pausedRun)
  c.lease = null
  delete s.cmds[c.id]
  s.runs[r].st = 'ending'
  s.runs[r].reason = 'user-rejected'
  runEndTurn(s, r)
}

function resumeTurn(s, c) {
  {
    const tr = tapeResumable(s)
    s.rset = s.rset.filter((x) => tr && x.pausedRun === tr.pausedRun)
  }
  if (!s.rset.length) return doneCmd(s, c, 'none')
  if (busy(s, c.id)) {
    s.undef.push('resume while a Run is in progress: :398 does not say')
    return doneCmd(s, c, 'none')
  }
  const L = acquire(s, c)
  if (!L) return doneCmd(s, c, 'refused')
  const it = s.rset[0]
  openResumeRun(s, L, it)
  c.lease = null
  delete s.cmds[c.id]
  s.trace.push('  -> resume started')
}

function continueTurn(s, c) {
  if (s.tape.last !== 'output-truncated' || busy(s, c.id)) return doneCmd(s, c, 'not-available')
  if (!c.pre) {
    const L = acquire(s, c)
    if (!L) return doneCmd(s, c, 'refused')
    c.stage = 'prebuild'
    return
  }
  if (c.pre === 'missing') return doneCmd(s, c, 'not-sent:config-missing')
  if (c.pre === 'confirm') return doneCmd(s, c, 'held')
  const L = acquire(s, c)
  if (!L) return doneCmd(s, c, 'refused')
  openRun(s, L, 'R', 'continue')
  c.lease = null
  delete s.cmds[c.id]
}

function stopTurn(s) {
  // :424 轮到时再查一次，只中止已开 Run 的活租约，否则按暂停中停止处理
  s.held = null
  const L = liveLease(s)
  if (L) {
    recStop(s, 'mailbox', L)
    abortLease(s, L, 'user-stop', true)
    s.trace.push('  stop(mailbox) aborts ' + L)
    return
  }
  const had = {
    p: s.tape.pending && s.tape.pending.id,
    r: tapeResumable(s) && tapeResumable(s).pausedRun,
  }
  const closed = writeStopClosure(s)
  if (!closed && (had.p || had.r) && s.app === 'normal')
    s.undef.push(
      'VIOLATION stop returned stopped:false while a card/resumable item was there (' +
        JSON.stringify(had) +
        ')',
    )
  s.trace.push('  stop(mailbox) stopped:' + closed)
}

function selectTurn(s) {
  s.tape.sessionChoice = true
  if (!s.held) return
  const h = s.held
  s.held = null
  if (activeRuns(s).length) return
  let items
  const it = h.q && s.queue.find((x) => x.q === h.q)
  if (h.q && !it) return // R3: held item gone (withdrawn): clear only, take nothing
  items = it ? take(s, { upTo: it.seq }) : take(s, {})
  if (!items.length) return
  const c = { id: nid(s, 'c'), kind: 'release', items, lease: null, pre: null, takenOver: false }
  s.cmds[c.id] = c
  const L = acquire(s, c)
  if (!L) {
    restore(s, items, {})
    delete s.cmds[c.id]
    return
  }
  c.stage = 'prebuild'
}

function batchTurn(s, rid) {
  const r = s.runs[rid]
  if (!r || r.st !== 'streaming') return
  const l = s.leases[r.lease]
  if (l && l.aborted) return // R3: aborted -> take nothing
  const got = take(s, {})
  if (s.held && s.held.q && got.some((x) => x.q === s.held.q)) s.held = null // R3: held item taken clears held
  const ms = got.map((x) => x.m)
  writeMsgs(s, ms)
}

function runEndTurn(s, rid) {
  const r = s.runs[rid]
  r.st = 'ended'
  const l = s.leases[r.lease]
  if (l && l.aborted) r.reason = abortReason(l.aborted) // R3: write task sees the abort; no paused/completed/error terminal
  if (l && l.stopHit && l.aborted === 'user-stop' && r.reason !== 'user-stopped')
    s.undef.push(
      'VIOLATION swallowed stop: stop aborted lease ' +
        r.lease +
        ' (stopped:true) but ' +
        rid +
        ' commits ' +
        r.reason,
    )
  if (r.sess === 'R') {
    s.tape.last = r.reason
    if (r.reason === 'paused')
      s.tape.pending = { sess: 'R', kind: 'approval', pausedRun: rid, id: nid(s, 'p') }
  } else {
    if (r.reason === 'paused')
      s.tape.pending = { sess: 'C', kind: 'approval', pausedRun: rid, id: nid(s, 'p') }
  }
  if (READ.runEndTask === 'split') {
    s.mb.push({ t: 'take', r: rid })
    return
  }
  // R4: the task awaits the run_terminal append (and take); stop/quit/close entry actions may land meanwhile,
  // the mailbox runs nothing else until the task finishes
  s.mb.unshift({ t: 'take', r: rid, cont: true })
}

function runTakeTurn(s, rid) {
  const r = s.runs[rid]
  const L = r.lease
  // R4 :428 look at the signal again after run_terminal / take: aborted meanwhile -> recompute by the abort cause
  // R5 :428 committed paused + user-stop meanwhile -> 暂停中停止 closure in this task (child first, parent after), then take by user-stopped.
  // R5 child handoff: the model's single interleaving point is before this step; signal check, finish and begin
  // below are one synchronous segment (the text now says so, after the handoff is generated).
  const lab = s.leases[L] && s.leases[L].aborted
  const eff = lab ? abortReason(lab) : r.reason
  if (r.sess === 'C') {
    // child with its own lease (parent already paused{subagent})
    if (r.reason === 'paused') {
      if (
        (lab === 'user-stop' || (READ.lateStop && lab)) &&
        s.leases[L].stopHit &&
        s.tape.pending &&
        s.tape.pending.pausedRun === rid
      ) {
        if (READ.fixPausedStop) {
          s.tape.pending = null
          s.tape.stopClosures++
          s.tape.parentWaiting = false
        } else
          s.undef.push(
            'VIOLATION swallowed stop (after commit): stop aborted child lease ' +
              L +
              ' (stopped:true) after run_terminal(paused); the child card stays pending',
          )
      }
      const items = eff === 'paused' ? [] : take(s, { urgentOnly: true })
      for (const x of s.queue) if (!x.urgent) x.owed = false
      finish(s, L)
      if (items.length) {
        const c = {
          id: nid(s, 'c'),
          kind: 'auto',
          items,
          lease: null,
          pre: null,
          takenOver: false,
          stage: 'prebuild',
        }
        const L2 = begin(s, 'cmd:' + c.id)
        if (!L2) {
          restore(s, items, { owed: false, urgent: false })
          return
        }
        c.lease = L2
        s.cmds[c.id] = c
      }
      return
    }
    if (
      r.reason === 'user-stopped' ||
      r.reason.startsWith('shutdown') ||
      (lab && !READ.childNoRecheck)
    ) {
      s.tape.parentWaiting = false // parent's Agent result aborted + rest not-run, no request
      // R3: then take like a root Run (urgent only after user-stopped / close-window) — falls through below
    } else {
      if (s.leases[L] && s.leases[L].stopHit)
        s.undef.push(
          'VIOLATION swallowed stop: stop aborted child lease ' +
            L +
            ' (stopped:true) after its run_terminal, yet the parent handoff Run opens',
        )
      finish(s, L)
      const L2 = begin(s, 'handoff')
      if (!L2) return // R3: refused -> parent writes nothing, left to startup recovery row 4
      s.tape.parentWaiting = false
      openRun(s, L2, 'R', 'resume', rid) // parent's handoff Run: result + run_started + model_selected in this task
      return
    }
  }
  // root Run
  if (
    r.reason === 'paused' &&
    (lab === 'user-stop' || (READ.lateStop && lab)) &&
    s.leases[L] &&
    s.leases[L].stopHit &&
    s.tape.pending &&
    s.tape.pending.pausedRun === rid
  ) {
    if (READ.fixPausedStop) {
      s.tape.pending = null
      s.tape.stopClosures++
    } // last run_terminal stays paused; run-ended.reason = paused
    else
      s.undef.push(
        'VIOLATION swallowed stop (after commit): stop aborted lease ' +
          L +
          ' (stopped:true) after run_terminal(paused); the card stays pending, no cancelled-by-stop/unanswered',
      )
  }
  let items = []
  const rs = eff
  if (rs === 'completed' || rs === 'user-rejected') items = take(s, {})
  else if (rs === 'user-stopped' || rs === 'shutdown-close-window')
    items = take(s, { urgentOnly: true })
  for (const x of s.queue) if (!x.urgent) x.owed = false
  if (!['completed', 'user-rejected', 'user-stopped', 'shutdown-close-window'].includes(rs))
    for (const x of s.queue) x.owed = false
  finish(s, L)
  if (items.length) {
    const c = {
      id: nid(s, 'c'),
      kind: 'auto',
      items,
      lease: null,
      pre: null,
      takenOver: false,
      stage: 'prebuild',
    }
    const L2 = begin(s, 'cmd:' + c.id)
    if (!L2) {
      restore(s, items, { owed: false, urgent: false })
      return
    } // R3: begin refused -> restore
    c.lease = L2
    s.cmds[c.id] = c
  }
}

// ---------------------------------------------------------------- invariants
function check(s) {
  const v = []
  const n = Object.keys(s.leases).length
  if (n > 1) v.push('VIOLATION two live leases on one root: ' + Object.keys(s.leases).join(','))
  for (const [id, r] of activeRuns(s))
    if (['streaming', 'assembling'].includes(r.st) && !s.leases[r.lease])
      v.push('VIOLATION ' + id + ' streams without a live lease')
  for (const u of s.undef) v.push(u)
  // INV card vs Run: a waiting card (or resumable item) and a live Run on the same tree at once
  const tr = tapeResumable(s)
  if (
    (s.tape.pending || tr) &&
    activeRuns(s).some(([, r]) => ['streaming', 'assembling'].includes(r.st))
  )
    v.push(
      'VIOLATION card/resumable item and a streaming Run coexist: ' +
        JSON.stringify(s.tape.pending || tr),
    )
  // INV D2: Tape-resumable => listed in kernel set (approval.list resume row, resume() works)
  if (s.app === 'normal' && tr && !s.rset.some((x) => x.pausedRun === tr.pausedRun))
    v.push(
      'VIOLATION Tape-resumable ' +
        tr.pausedRun +
        ' missing from kernel resumable set (no resume row; resume() returns none)',
    )
  return v
}
function quiescent(s) {
  return (
    !Object.keys(s.leases).length &&
    !Object.keys(s.cmds).length &&
    !s.mb.length &&
    !activeRuns(s).length
  )
}
function checkQuiescent(s) {
  const v = []
  if (s.app !== 'quitting')
    for (const x of s.queue)
      if (x.owed)
        v.push(
          'VIOLATION stranded ' +
            (x.urgent ? 'urgent ' : x.afterStop ? 'sent-after-stop ' : '') +
            'queue item ' +
            x.q +
            ': session idle, nothing will send it',
        )
  for (const [m, st] of Object.entries(s.mstat))
    if (st === 'taken' || st === 'in-flight')
      v.push('VIOLATION message ' + m + ' lost (status ' + st + ')')
  // order: among non-urgent issued messages, tape order must follow issue order
  const pos = (m) => s.tape.msgs.indexOf(m)
  const plain = s.issued.filter((x) => !x.urgent && pos(x.m) >= 0)
  for (let i = 0; i + 1 < plain.length; i++)
    if (pos(plain[i].m) > pos(plain[i + 1].m))
      v.push(
        'VIOLATION order inversion: ' +
          plain[i].m +
          ' sent by user before ' +
          plain[i + 1].m +
          ' but written after it',
      )
  // child consistency
  const p = s.tape.pending
  const tr = tapeResumable(s)
  // INV stop promise: every stop that returned stopped:true closed the card / resumable item it saw
  for (const r of s.stopRecs) {
    if (r.p && s.tape.pending && s.tape.pending.id === r.p)
      v.push(
        'VIOLATION swallowed stop (' +
          r.via +
          '): card ' +
          r.p +
          ' still pending after stop returned stopped:true',
      )
    if (r.r && tr && tr.pausedRun === r.r)
      v.push(
        'VIOLATION swallowed stop (' +
          r.via +
          '): resumable ' +
          r.r +
          ' still resumable after stop returned stopped:true',
      )
  }
  // INV B4: quit leaves cards
  const asked = (s.stopAsked || []).concat(s.stopRecs)
  if (
    s.app === 'quitting' &&
    s.quitCards &&
    !asked.some((a) => (a.p && a.p === s.quitCards.p) || (a.r && a.r === s.quitCards.r))
  ) {
    if (s.quitCards.p && !(s.tape.pending && s.tape.pending.id === s.quitCards.p))
      v.push('VIOLATION B4: card ' + s.quitCards.p + ' closed by quit')
    if (s.quitCards.r && !(tr && tr.pausedRun === s.quitCards.r))
      v.push('VIOLATION B4: resumable ' + s.quitCards.r + ' consumed by quit')
  }
  if (s.app === 'quitting') return v // quit: leftovers are for startup recovery
  if ((p && p.sess === 'C') || (tr && tr.sess === 'C'))
    if (!s.tape.parentWaiting) v.push('VIOLATION child waiting without a waiting parent')
  if (s.tape.parentWaiting && !(p && p.sess === 'C') && !(tr && tr.sess === 'C'))
    v.push('VIOLATION parent paused{subagent} but child neither pending, running nor resumable')
  if (s.held && s.held.q && s.mstat['m' + s.held.q.slice(1)] === 'written')
    v.push('VIOLATION held names an item already written to the Tape')
  // resumable set vs Tape
  if (s.rset.length && !tr)
    v.push(
      'VIOLATION kernel resumable set lists ' +
        JSON.stringify(s.rset) +
        ' but Tape says not resumable (a Run already points to it)',
    )
  return v
}

module.exports = {
  initial,
  userActions,
  envActions,
  check,
  quiescent,
  checkQuiescent,
  key,
  clone,
  READ,
}
