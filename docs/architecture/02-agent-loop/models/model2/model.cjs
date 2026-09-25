// Executable model #2 of spec 02 §主进程与 kernel 的循环接口 — answers, continuation Runs,
// resumable items after restart, child sub-agent chain. Plain JS, no deps.
// Rules are encoded AS WRITTEN; where the text does not decide, we record an UNDET tag
// (first = shortest trace, BFS) and continue with the most literal reading.
'use strict'
// Round 3 (R3) rules encoded: no takeover; entry begins only with no live lease and no command queued or waiting;
// resume begins at its turn; while a command holds the lease pre-Run the mailbox runs only it (and stop);
// Run write tasks check the signal; child own-lease Run ends take urgent; handoff appended in the child-end task;
// resumable set removed by any run_started{resume} and re-checked against the Tape; held cleared on new round / item taken.

const MAXDEPTH = +(process.argv[2] || 9)
const FIX = new Set([
  'rs',
  'urgent',
  'abortwins',
  ...(process.argv[3] || '').split(',').filter(Boolean),
]) // R3: all three are now the text
// R4 switches: KEYCHAIN_HANG = prebuild never resolves unless its lease is aborted (the text races lease.signal);
// CHILD_NO_RECHECK = demo of the pre-R4 text (no signal re-check after the child's run_terminal)
// R5: PAUSED_NO_RECHECK = demo of the pre-R5 text (a user-stop landing during the paused commit only recomputes the take)
// R6: RunLease.stopRequested (L.sh) — set by every abort('user-stop'), even on a lease already aborted by quit/close;
// the before-append and run-end branches close like a stop when it is set. PRE_R6_STOP = demo of the pre-R6 text.
const AU = {
  lateStop: !process.env.PRE_R6_STOP,
  hang: !!process.env.KEYCHAIN_HANG,
  noRecheck: !!process.env.CHILD_NO_RECHECK,
  pausedNoRecheck: !!process.env.PAUSED_NO_RECHECK,
}
const BUDGET = {
  send: 2,
  stop: 2,
  resume: 2,
  sel: 1,
  crash: 1,
  quit: 1,
  spawn: 1,
  answer: 2,
  sendNowQ: 1,
  close: +(process.env.CLOSE_BUDGET || 1),
}

const clone = (s) => JSON.parse(JSON.stringify(s))
const undet = new Map() // tag -> {trace, note, lines}
const viol = new Map() // tag -> {trace, note, lines}
let curTrace = null
function U(s, tag, note, lines) {
  if (!undet.has(tag)) undet.set(tag, { trace: curTrace, note, lines })
}
function V(tag, note, lines) {
  if (!viol.has(tag)) viol.set(tag, { trace: curTrace, note, lines })
}

// ---------- state ----------
function base(wc) {
  return {
    ph: 'N',
    wc, // wc: what prebuild (resolveChoice/assemble/provider) yields for a NEW round: ok|miss|conf
    L: [],
    nl: 1, // live leases {id,h,ab}  h='c<n>' command/kernel-task, 'r<n>' run
    runs: {},
    nr: 1, // live runs {s:'R'|'C', st:'stream'|'wait'|'abort'|'w', lease, onP, cause}
    T: {
      // Tape facts that matter
      R: { last: null, pend: null, pp: false, tight: false, agent: null, contOf: 0 },
      C: { ex: false, last: null, pend: null, pp: false, tight: false, contOf: 0 },
    },
    rs: [], // kernel in-memory resumable set
    q: [],
    seq: 1, // main-process queue {id,seq,u}
    held: null, // {qid|null}
    mb: [], // mailbox of task ids
    cmds: {},
    nc: 1, // commands / kernel tasks
    texts: {},
    nt: 1, // text id -> fate: 'cmd'|'q'|'sent'|'notSent'|'dropped'|'taken'
    sentLog: [],
    used: {},
    quiesceOk: true,
    pg: { R: 0, C: 0 },
    stopRecs: [],
    stopAsked: [],
    quitCards: null,
  }
}
function inits() {
  const out = []
  for (const wc of ['ok', 'miss', 'conf']) {
    let s = base(wc)
    s.T.R.last = 'completed'
    out.push(['idle/' + wc, s])
    s = base(wc)
    s.T.R.last = 'paused-A'
    s.T.R.pend = 'A'
    out.push(['pausedA/' + wc, s])
    s = base(wc)
    s.T.R.last = 'paused-Q'
    s.T.R.pend = 'Q'
    out.push(['pausedQ/' + wc, s])
    s = base(wc)
    s.T.R.last = 'paused-sub'
    s.T.R.agent = 'open'
    s.T.C = { ex: true, last: 'paused-A', pend: 'A', pp: false, tight: false, contOf: 0 }
    out.push(['childPending/' + wc, s])
    s = base(wc)
    s.T.R.last = 'paused-A'
    s.T.R.tight = true
    s.rs = ['R']
    out.push(['resumableR/' + wc, s])
    s = base(wc)
    s.T.R.last = 'paused-sub'
    s.T.R.agent = 'open'
    s.T.C = { ex: true, last: 'paused-A', pend: null, pp: false, tight: true, contOf: 0 }
    s.rs = ['C']
    out.push(['resumableC/' + wc, s])
    s = base(wc)
    s.T.R.last = 'completed'
    s.L.push({ id: 1, h: 'r1', ab: null })
    s.nl = 2
    s.runs['1'] = { s: 'R', st: 'stream', lease: 1, onP: false, cause: 'msg' }
    s.nr = 2
    out.push(['running/' + wc, s])
  }
  return out
}

// ---------- INV helpers ----------
const RES = (s, x) => s.T[x].tight && s.T[x].contOf === 0
function cardsNow(s) {
  const o = []
  for (const x of ['R', 'C']) {
    if (s.T[x].pend) o.push('p' + x + s.pg[x])
    if (RES(s, x)) o.push('res' + x)
  }
  return o
}
function recStop(s, via, l) {
  if (l && l.ab && process.env.SKIP_NOOP_STOP) return
  s.stopRecs.push({
    via: via + (l && l.ab ? ',lease already aborted by ' + l.ab : ''),
    cards: cardsNow(s),
  })
}
// ---------- helpers ----------
const leaseById = (s, id) => s.L.find((l) => l.id === id)
function begin(s, h) {
  if (s.ph === 'Q') return null
  if (s.L.length > 0) V('two-leases', 'begin called while root has a live lease', ':418')
  const id = s.nl++
  s.L.push({ id, h, ab: null })
  return id
}
function finish(s, id) {
  s.L = s.L.filter((l) => l.id !== id)
}
function abortLease(s, id, cause) {
  const l = leaseById(s, id)
  if (!l) return
  if (cause === 'stop') l.sh = true
  if (l.ab) return
  l.ab = cause
  for (const r of Object.values(s.runs)) if (r.lease === id && r.st !== 'w') r.st = 'abort'
  for (const c of Object.values(s.cmds))
    if (c.preLease === id && c.ph === 'pre') c.preAborted = true
}
function openRun(s, sess, cause, lease, onP = false) {
  if (cause === 'msg' && s.wc === 'conf')
    V('D3-unconfirmed-host', 'new round opened while the host is unconfirmed', ':425')
  if (cause !== 'resume' && (RES(s, 'R') || RES(s, 'C')))
    V(
      'newround-bypasses-resumable',
      `${cause} Run opened while the Tape has a resumable item`,
      ':1462,:1772',
    )
  {
    const l0 = leaseById(s, lease)
    if (l0 && l0.ab)
      V('run-on-aborted-lease', `${cause} Run opened on a lease aborted by ${l0.ab}`, ':416,:423')
  }
  const id = String(s.nr++)
  s.runs[id] = { s: sess, st: 'stream', lease, onP, cause }
  const l = leaseById(s, lease)
  if (l && !onP) l.h = 'r' + id
  if (!lease || !l)
    V('run-without-lease', `run ${id} (${sess},${cause}) opened with no live lease`, ':418,:1690')
  return id
}
function pointPaused(s, sess) {
  // a Run with cause.pausedRunId -> this session's paused run
  const t = s.T[sess]
  t.contOf++
  if (t.contOf > 1)
    V(
      'double-continuation',
      `second Run points at the same paused Run of ${sess}`,
      ':397,:1287,:1769',
    )
}
function enqueueText(s, tid, urgent, qItem) {
  if (qItem) {
    const it = { ...qItem, u: urgent || qItem.u }
    restoreQ(s, [it])
    return it
  }
  const it = { id: tid, seq: s.seq++, u: urgent }
  s.q.push(it)
  s.texts[tid] = 'q'
  return it
}
function sendTexts(s, ids, tag) {
  if (ids.length && (s.T.R.pend || s.T.C.pend || s.T.R.agent === 'open'))
    V(
      'msg-while-card',
      `message/user ${ids} (${tag}) written while a card waits (R.pend=${s.T.R.pend} C.pend=${s.T.C.pend} agent=${s.T.R.agent})`,
      ':1461,:2543',
    )
  if (ids.length && s.q.some((x) => x.u))
    V(
      'urgent-overtaken',
      `${ids} (${tag}) written while urgent item ${s.q.filter((x) => x.u).map((x) => x.id)} stays queued`,
      ':430,:1461',
    )
  for (const id of ids) {
    if (s.texts[id] === 'sent') V('dup-sent', `text ${id} sent twice`, ':1452')
    s.texts[id] = 'sent'
    s.sentLog.push(id)
  }
  // order: a non-urgent text must not overtake an older non-urgent text still queued
  for (const id of ids) {
    const mine = s.textOrd?.[id]
    const urgent = s.textUrg?.[id]
    if (urgent) continue
    for (const it of s.q)
      if (!it.u && s.textOrd[it.id] < mine)
        V('overtake', `text ${id} (${tag}) sent before older queued text ${it.id}`, ':421,:1461')
  }
}
function takeQ(s, pred) {
  const out = s.q.filter(pred)
  s.q = s.q.filter((x) => !pred(x))
  for (const x of out) s.texts[x.id] = 'taken'
  return out
}
function restoreQ(s, items) {
  for (const x of items) {
    s.q.push(x)
    s.texts[x.id] = 'q'
  }
  s.q.sort((a, b) => a.seq - b.seq)
}
const rootRun = (s) => Object.entries(s.runs).find(([, r]) => r.s === 'R')
const childRun = (s) => Object.entries(s.runs).find(([, r]) => r.s === 'C')
const holderCmd = (s, l) => (l && l.h[0] === 'c' ? s.cmds[l.h.slice(1)] : null)

// state judgement used by send / auto-send at their mailbox turn (§何时判定 + state table)
function judge(s, selfId) {
  const rs = Object.values(s.runs)
  if (rs.some((r) => r.st !== 'abort')) return 'running'
  if (rs.some((r) => r.st === 'abort')) return 'stopping'
  const l = s.L[0]
  if (l && l.h !== 'c' + selfId && holderCmd(s, l))
    V(
      'judged-behind-holder',
      'a command was judged while another command held the lease pre-Run (R3 blocks the mailbox)',
      ':420',
    )
  if (s.T.R.pend === 'Q') return 'question'
  s.rs = s.rs.filter((x) => s.T[x].tight && s.T[x].contOf === 0) // R3: re-check the Tape
  if (s.rs.length) return 'resumable'
  if (s.T.R.pend === 'A' || s.T.C.pend === 'A') return 'approval'
  if (s.T.R.agent === 'open') {
    V(
      'handoff-window',
      'root paused{subagent} with the child ended and no handoff Run (R3 appends it in the child-end task)',
      ':428',
    )
    return 'handoff-window'
  }
  return 'idle'
}

// acquire a lease inside the mailbox for command c (§租约)
function acquire(s, c) {
  if (c.lease && leaseById(s, c.lease)) return c.lease
  if (s.L.length === 0) {
    const id = begin(s, 'c' + c.id)
    c.lease = id
    return id
  }
  const l = s.L[0]
  V(
    'acquire-with-live-lease',
    `${c.t} must open a Run but the live lease is held by ${l.h} (R3: lease never changes hands)`,
    ':420',
  )
  return null
}
function releaseOwn(s, c) {
  if (c.lease && leaseById(s, c.lease) && leaseById(s, c.lease).h === 'c' + c.id) finish(s, c.lease)
  c.lease = null
}

// stop's closing by state (used by stop turn and by aborted-before-append user-stop)
function stopClose(s, via, heldLease) {
  const T = s.T
  if (T.R.pend === 'A') {
    T.R.pend = null
    return 'cancelled'
  }
  if (T.R.pend === 'Q') {
    T.R.pend = null
    return 'unanswered'
  }
  if (T.C.pend === 'A') {
    T.C.pend = null
    T.R.agent = 'done'
    return 'cancelled-child'
  }
  s.rs = s.rs.filter((x) => T[x].tight && T[x].contOf === 0) // R3: re-check the Tape
  const tr = ['R', 'C'].find((x) => T[x].tight && T[x].contOf === 0)
  if (tr) {
    const sess = tr
    if (!s.rs.includes(sess))
      V('stop-resumable-set-vs-tape', 'stop: Tape says resumable but kernel set does not', ':400')
    const lid = heldLease || begin(s, 'stoprun')
    if (lid == null) return 'refused' // R3: stop Run begins a lease
    pointPaused(s, sess)
    T[sess].tight = false
    T[sess].last = 'user-stopped'
    if (sess === 'C') T.R.agent = 'done'
    s.rs = s.rs.filter((x) => x !== sess)
    if (s.q.some((x) => x.u))
      V('stop-run-urgent', 'urgent item present at stop-on-resumable', ':428')
    if (!heldLease) finish(s, lid)
    return 'stop-run'
  }
  return 'nothing'
}

// Run end inside the mailbox (§Run 结束). R4: run_terminal is committed first; the rest of the same task
// (take, finish, begin) runs after an await, so stop / quit entry actions can land in between; the mailbox
// runs nothing else until the task finishes. After the commit/take the task looks at the signal again.
function runEnd(s, rid, reason) {
  const r = s.runs[rid]
  delete s.runs[rid]
  s.T[r.s].last = reason
  if (r.onP) throw new Error('child on parent lease handled elsewhere')
  const c = { id: s.nc++, t: 'cont', r, rid, reason }
  s.cmds[c.id] = c
  s.mb.unshift(c.id)
}
const TAKE_NONE = () => false
const TAKE_ALL = () => true
const TAKE_URGENT = (x) => x.u
function runEndCont(s, c) {
  const { r, reason } = c
  const L = leaseById(s, r.lease)
  const ab = L && L.ab
  const eff = ab
    ? ab === 'stop'
      ? 'user-stopped'
      : ab === 'close'
        ? 'shutdown-close'
        : 'shutdown-quit'
    : reason
  const takeFinishBegin = () => {
    let pred = TAKE_NONE
    if (eff === 'completed' || eff === 'user-rejected') pred = TAKE_ALL
    else if (eff === 'user-stopped' || eff === 'shutdown-close') pred = TAKE_URGENT
    const taken = takeQ(s, pred)
    finish(s, r.lease)
    if (taken.length) {
      const id = begin(s, 'c' + s.nc)
      if (id == null) {
        restoreQ(
          s,
          taken.map((x) => ({ ...x, u: false })),
        )
        return
      } // refused -> restore, urgent cleared
      const a = { id: s.nc++, t: 'auto', ph: 'pre', lease: id, preLease: id, taken, pre: null }
      s.cmds[a.id] = a
    }
  }
  // R5 :428 committed paused + user-stop meanwhile -> 暂停中停止 closure in this task (child first, parent after); run-ended.reason stays the committed one
  if (
    (ab === 'stop' || (AU.lateStop && L && L.sh)) &&
    ['paused-A', 'paused-Q', 'paused-sub'].includes(reason)
  ) {
    if (!AU.pausedNoRecheck) {
      const T = s.T
      if (T[r.s].pend) {
        T[r.s].pend = null
        if (r.s === 'C') T.R.agent = 'done'
      }
      if (reason === 'paused-sub' && T.C.pend) {
        T.C.pend = null
        T.R.agent = 'done'
      }
    } else
      V(
        'swallowed-stop-after-commit',
        `stop aborted lease ${r.lease} (stopped:true) after run_terminal(${reason}) committed; the card stays pending`,
        ':428,:1537',
      )
  }
  if (r.s === 'R' || reason === 'paused-A') return takeFinishBegin()
  // child session Run with its own lease
  // R5: the handoff is generated before this point; signal check, finish and begin below are one synchronous segment
  const stopped =
    reason === 'user-stopped' || reason === 'shutdown-quit' || reason === 'shutdown-close'
  if (stopped || (ab && !AU.noRecheck)) {
    // R4 re-check: aborted after the child's run_terminal -> no handoff Run
    s.T.R.agent = 'done' // parent Agent result aborted (childEndReason = the committed one) + parent same-batch not-run
    return takeFinishBegin()
  }
  if (ab === 'stop')
    V(
      'swallowed-stop',
      'stop aborted the child lease after its run_terminal (stopped:true), yet the parent handoff Run opens',
      ':428',
    )
  finish(s, r.lease)
  const id = begin(s, 'handoff')
  if (id == null) return // refused -> parent writes nothing; startup recovery row 4
  s.T.R.agent = 'done'
  pointPaused(s, 'R') // handoff result + run_started + model_selected in this task
  openRun(s, 'R', 'resume', id)
}

// ---------- mailbox processing ----------
const CMD_T = new Set(['send', 'answer', 'resume', 'stop', 'sel', 'sendq'])
function nextIndex(s) {
  // R3 blocking
  const ci = s.mb.findIndex((id) => s.cmds[id] && s.cmds[id].t === 'cont')
  if (ci >= 0) return ci // R4: run-end task runs to completion
  const l = s.L[0]
  const h = l && l.h[0] === 'c' ? l.h.slice(1) : null
  if (!h) return s.mb.length ? 0 : -1
  return s.mb.findIndex(
    (id) => String(id) === h || (s.cmds[id] && (s.cmds[id].t === 'stop' || s.cmds[id].t === 'rw')),
  )
}
function processHead(s, i) {
  const id = s.mb.splice(i || 0, 1)[0]
  const c = s.cmds[id]
  if (!c) return
  if (c.t === 'rw') return runWrite(s, c, id)
  if (c.t === 'cont') {
    delete s.cmds[id]
    return runEndCont(s, c)
  }
  delete s.cmds[id]
  const own = c.lease && leaseById(s, c.lease)
  // aborted after begin, before append
  if (own && own.ab && own.h === 'c' + c.id) {
    if (c.taken)
      restoreQ(
        s,
        c.taken.map((x) => ({ ...x, u: false })),
      ) // R3: urgent cleared
    if (own.ab === 'stop' || (AU.lateStop && own.sh)) stopClose(s, 'cmd', own.id)
    if (c.text) s.texts[c.text] = 'notSent'
    if (c.t === 'resume')
      V('resume-aborted', 'resume aborted before append (R3: begins at its turn)', ':420')
    finish(s, own.id)
    return
  }
  if (c.preAborted && !own && (c.t === 'send' || c.t === 'auto'))
    V('lost-lease', `${c.t} lost its lease (R3: never)`, ':420')
  switch (c.t) {
    case 'send':
      return doSend(s, c)
    case 'answer':
      return doAnswer(s, c)
    case 'resume':
      return doResume(s, c)
    case 'stop':
      return doStop(s, c)
    case 'sel':
      return doSel(s, c)
    case 'auto':
      return doAuto(s, c)
    case 'handoff':
      return doHandoff(s, c)
  }
}

function doSend(s, c) {
  const st = judge(s, c.id)
  if (st === 'running') {
    const target = c.urgentRun && s.runs[c.urgentRun]
    if (target) {
      // R5 literal :430: still running = run_terminal not committed, aborted or not
      abortLease(s, target.lease, 'stop')
      enqueueText(s, c.text, true, c.qItem)
      s.textUrg[c.text] = true
    } else enqueueText(s, c.text, false, c.qItem)
    releaseOwn(s, c)
    return
  }
  if (st === 'stopping') {
    enqueueText(s, c.text, true, c.qItem)
    s.textUrg[c.text] = true
    releaseOwn(s, c)
    return
  }
  if (st === 'question') {
    // typed reply
    const l = acquire(s, c)
    if (!l) {
      s.texts[c.text] = 'notSent'
      return
    }
    s.T.R.pend = null
    s.texts[c.text] = 'sent'
    s.sentLog.push(c.text + '(answer)')
    pointPaused(s, 'R')
    openRun(s, 'R', 'resume', l)
    return
  }
  if (st === 'resumable') {
    const sess = s.rs[0]
    const l = acquire(s, c)
    if (!l) return
    pointPaused(s, sess)
    s.T[sess].tight = false
    openRun(s, sess, 'resume', l) // R3: child case — text waits in the parent queue for the handoff Run
    enqueueText(s, c.text, false, c.qItem)
    // As written only resume() and stop() remove from the set (:397)
    if (FIX.has('rs')) s.rs = s.rs.filter((x) => x !== sess)
    return
  }
  if (st === 'handoff-window') {
    enqueueText(s, c.text, false, c.qItem)
    releaseOwn(s, c)
    return
  }
  // approval (supersede) or idle (new round)
  if (c.pre == null) {
    const l = acquire(s, c)
    if (!l) {
      s.texts[c.text] = 'notSent'
      return
    }
    c.ph = 'pre'
    c.preLease = l
    c.pre = null
    s.cmds[c.id] = c
    return // leave mailbox to prebuild
  }
  if (c.pre === 'miss') {
    s.texts[c.text] = 'notSent'
    releaseOwn(s, c)
    return
  }
  if (c.pre === 'conf') {
    const it = enqueueText(s, c.text, false, c.qItem)
    s.held = { qid: it.id }
    releaseOwn(s, c)
    return
  }
  const l = acquire(s, c)
  if (!l) {
    s.texts[c.text] = 'notSent'
    return
  }
  if (s.held && s.wc !== 'ok')
    V('held-bypass', 'new round opened to an unconfirmed host while held is set', ':425')
  s.held = null // R3: a new round clears held
  if (st === 'approval') {
    if (s.T.R.pend === 'A') s.T.R.pend = null
    if (s.T.C.pend === 'A') {
      s.T.C.pend = null
      s.T.R.agent = 'done'
    }
  }
  const before = takeQ(s, () => true) // R3: take all queued at the turn
  sendTexts(s, [...before.map((x) => x.id), c.text], 'send')
  openRun(s, 'R', 'msg', l)
}

function doAnswer(s, c) {
  const t = s.T[c.sess]
  if (t.pend !== 'A') {
    releaseOwn(s, c)
    return
  }
  const l = acquire(s, c)
  if (!l) return
  t.pend = null
  pointPaused(s, c.sess)
  if (c.sess === 'C') {
    openRun(s, 'C', 'resume', l)
    return
  }
  if (c.dec === 'allow') {
    openRun(s, 'R', 'resume', l)
    return
  }
  const rid = openRun(s, 'R', 'reject', l)
  runEnd(s, rid, 'user-rejected')
}

function doResume(s, c) {
  s.rs = s.rs.filter((x) => s.T[x].tight && s.T[x].contOf === 0) // R3: re-check the Tape
  if (!s.rs.length || Object.keys(s.runs).length) {
    releaseOwn(s, c)
    return
  }
  const sess = s.rs[0]
  const l = acquire(s, c)
  if (!l) return
  s.rs = s.rs.filter((x) => x !== sess)
  pointPaused(s, sess)
  s.T[sess].tight = false
  openRun(s, sess, 'resume', l)
}

function doStop(s, _c) {
  s.held = null
  const l = s.L[0]
  if (l) {
    recStop(s, 'mailbox', l)
    abortLease(s, l.id, 'stop')
    return
  } // R3: any live lease
  const had = cardsNow(s)
  const r = stopClose(s, 'stop')
  if ((r === 'nothing' || r === 'refused') && had.length && s.ph === 'N')
    V(
      'stop-false-with-card',
      'stop returned stopped:false while ' + had + ' was there',
      ':1669,:1718',
    )
}

function doSel(s, _c) {
  s.wc = 'ok'
  if (!s.held) return
  const h = s.held
  s.held = null
  if (Object.keys(s.runs).length) return
  const hi = h.qid != null && s.q.find((x) => x.id === h.qid)
  if (h.qid != null && !hi) return // R3: held item gone -> clear only
  const taken = takeQ(s, hi ? (x) => x.seq <= hi.seq : () => true)
  if (!taken.length) return
  const a = { id: s.nc++, t: 'auto', ph: 'pre', taken, pre: null }
  const lid = acquire(s, a)
  if (!lid) {
    restoreQ(s, taken)
    return
  }
  a.preLease = lid
  s.cmds[a.id] = a
}

const unU = (xs) => xs.map((x) => Object.assign({}, x, { u: false }))
function doAuto(s, c) {
  if (c.pre === 'miss') {
    restoreQ(s, unU(c.taken))
    releaseOwn(s, c)
    return
  }
  if (c.pre === 'conf') {
    restoreQ(s, unU(c.taken))
    s.held = { qid: null }
    releaseOwn(s, c)
    return
  }
  const st = judge(s, c.id)
  if (st === 'running' || st === 'stopping' || st === 'question' || st === 'resumable') {
    V(
      'auto-found-' + st,
      `auto-send found the root '${st}' (R3: impossible, lease never changes hands)`,
      ':420',
    )
    restoreQ(s, c.taken)
    releaseOwn(s, c)
    return
  }
  const l = acquire(s, c)
  if (!l) {
    restoreQ(s, c.taken)
    return
  }
  if (s.held && s.wc !== 'ok')
    V('held-bypass', 'auto-send opened a new round to an unconfirmed host', ':425')
  s.held = null
  if (st === 'approval') {
    if (s.T.R.pend === 'A') s.T.R.pend = null
    if (s.T.C.pend === 'A') {
      s.T.C.pend = null
      s.T.R.agent = 'done'
    }
  }
  sendTexts(
    s,
    c.taken.map((x) => x.id),
    'auto',
  )
  openRun(s, 'R', 'msg', l)
}

function doHandoff(s, c) {
  s.T.R.agent = 'done'
  const l = leaseById(s, c.lease)
  if (!l || l.h !== 'c' + c.id) {
    U(s, 'handoff-lease-lost', 'handoff Run lease was taken over before its append', ':418,:425')
    return
  }
  openRun(s, 'R', 'resume', l.id)
}

// run writes, serialized through the mailbox
function runWrite(s, c, id) {
  delete s.cmds[id]
  const r = s.runs[c.run]
  if (!r) return
  r.st = r.st === 'w' ? c.prevSt || 'stream' : r.st
  const L = leaseById(s, r.lease)
  if (!L) V('write-without-lease', `run ${c.run} writes with no live lease`, ':418')
  const aborted = L && L.ab
  if (
    aborted &&
    FIX.has('abortwins') &&
    [
      'pauseA',
      'pauseQ',
      'childPauseP',
      'complete',
      'error',
      'boundary',
      'spawn',
      'childDoneP',
    ].includes(c.what)
  ) {
    const r2 = s.runs[c.run]
    r2.st = 'abort'
    if (r2.onP) {
      const [, p] = rootRun(s)
      p.st = 'abort'
    }
    return
  }
  if (aborted && ['pauseA', 'pauseQ', 'childPauseP', 'complete', 'error'].includes(c.what))
    V(
      'write-after-abort-' + c.what,
      `the Run's ${c.what} append was already queued in the mailbox when its lease was aborted (stop / sendNow); text does not say whether the queued append re-checks the signal`,
      ':416,:424,:1534',
    )
  switch (c.what) {
    case 'boundary': {
      if (r.s !== 'R') return
      const items = takeQ(s, () => true)
      if (s.held && items.some((x) => x.id === s.held.qid)) s.held = null // R3: held item taken clears held
      sendTexts(
        s,
        items.map((x) => x.id),
        'boundary',
      )
      return
    }
    case 'complete':
      return runEnd(s, c.run, 'completed')
    case 'error':
      return runEnd(s, c.run, 'provider-error')
    case 'pauseA':
      s.pg[r.s]++
      s.T[r.s].pend = 'A'
      s.T[r.s].pp = false
      s.T[r.s].contOf = 0
      return runEnd(s, c.run, 'paused-A')
    case 'pauseQ':
      s.pg.R++
      s.T.R.pend = 'Q'
      s.T.R.contOf = 0
      return runEnd(s, c.run, 'paused-Q')
    case 'spawn': {
      s.T.R.agent = 'open'
      s.T.C = { ex: true, last: null, pend: null, pp: false, tight: false, contOf: 0 }
      r.st = 'wait'
      const cid = String(s.nr++)
      s.runs[cid] = {
        s: 'C',
        st: aborted ? 'abort' : 'stream',
        lease: r.lease,
        onP: true,
        cause: 'agent',
      }
      return
    }
    case 'childDoneP': {
      // child on parent lease ends non-paused
      delete s.runs[c.run]
      s.T.C.last = 'completed'
      s.T.R.agent = 'done'
      const [, p] = rootRun(s)
      p.st = aborted ? 'abort' : 'stream'
      return
    }
    case 'childPauseP': {
      delete s.runs[c.run]
      s.pg.C++
      s.T.C.pend = 'A'
      s.T.C.last = 'paused-A'
      s.T.C.contOf = 0
      const [pid] = rootRun(s)
      return runEnd(s, pid, 'paused-sub')
    }
    case 'abortEnd': {
      const reason =
        L.ab === 'stop' ? 'user-stopped' : L.ab === 'close' ? 'shutdown-close' : 'shutdown-quit'
      if (r.onP) {
        // child on parent lease: child ends, parent writes Agent aborted, parent ends
        delete s.runs[c.run]
        s.T.C.last = reason
        s.T.R.agent = 'done'
        const [pid] = rootRun(s)
        return runEnd(s, pid, reason)
      }
      if (r.s === 'R' && Object.values(s.runs).some((x) => x.onP)) return
      return runEnd(s, c.run, reason)
    }
  }
}

const mbHasCmd = (s) => s.mb.some((id) => s.cmds[id] && CMD_T.has(s.cmds[id].t))
// ---------- actions ----------
const bump = (n, k) => {
  n.used[k] = (n.used[k] || 0) + 1
}
function actions(s) {
  const A = []
  const u = (k) => (s.used[k] || 0) < BUDGET[k]
  // user: send (optionally urgent bound to the visible run)
  if (u('send') && s.ph === 'N') {
    const vis = (() => {
      const l = s.L[0]
      if (!l || l.h[0] !== 'r') return null
      return l.h.slice(1)
    })()
    for (const urgent of vis ? [null, vis] : [null]) {
      A.push([
        `send${urgent ? '(sendNow run' + urgent + ')' : ''}`,
        (n) => {
          bump(n, 'send')
          const tid = 't' + n.nt++
          n.texts[tid] = 'cmd'
          n.textOrd[tid] = n.ordC++
          const c = {
            id: n.nc++,
            t: 'send',
            text: tid,
            urgentRun: urgent,
            lease: null,
            pre: null,
            peekSeq: n.seq - 1,
          }
          n.cmds[c.id] = c
          const knownWait = n.T.R.pend === 'Q' || n.rs.length > 0
          if (n.L.length === 0 && !mbHasCmd(n)) {
            c.lease = begin(n, 'c' + c.id)
            if (!knownWait) {
              c.ph = 'pre'
              c.preLease = c.lease
              return
            }
          }
          c.ph = 'mb'
          n.mb.push(c.id)
        },
      ])
    }
  }
  // queue.act send-now on a queued item while a run is visible
  if (u('sendNowQ') && s.ph === 'N' && s.q.length && s.L[0] && s.L[0].h[0] === 'r') {
    A.push([
      'queue.act send-now',
      (n) => {
        bump(n, 'sendNowQ')
        const it = n.q[n.q.length - 1]
        const run = n.L[0].h.slice(1)
        const c = { id: n.nc++, t: 'sendq', qid: it.id, urgentRun: run, ph: 'mb' }
        n.cmds[c.id] = c
        n.mb.push(c.id)
      },
    ])
  }
  // user: answer
  for (const sess of ['R', 'C']) {
    if (u('answer') && s.ph === 'N' && s.T[sess].pend === 'A')
      for (const dec of ['allow', 'deny']) {
        A.push([
          `answer ${sess} ${dec}`,
          (n) => {
            bump(n, 'answer')
            const c = { id: n.nc++, t: 'answer', sess, dec, ph: 'mb', lease: null }
            n.cmds[c.id] = c
            if (n.L.length === 0 && !mbHasCmd(n)) c.lease = begin(n, 'c' + c.id)
            n.mb.push(c.id)
          },
        ])
      }
  }
  if (u('resume') && s.ph === 'N')
    A.push([
      'approval.resume',
      (n) => {
        bump(n, 'resume')
        const c = { id: n.nc++, t: 'resume', ph: 'mb', lease: null }
        n.cmds[c.id] = c
        n.mb.push(c.id) // R3: resume begins at its turn
      },
    ])
  if (u('stop') && s.ph === 'N')
    A.push([
      'stop',
      (n) => {
        bump(n, 'stop')
        n.held = null
        const l = n.L[0]
        if (l) {
          recStop(n, 'entry', l)
          abortLease(n, l.id, 'stop')
          return
        }
        n.stopAsked.push(...cardsNow(n))
        const c = { id: n.nc++, t: 'stop', ph: 'mb' }
        n.cmds[c.id] = c
        n.mb.push(c.id)
      },
    ])
  if (u('sel') && s.ph === 'N')
    A.push([
      'selectModel',
      (n) => {
        bump(n, 'sel')
        const c = { id: n.nc++, t: 'sel', ph: 'mb' }
        n.cmds[c.id] = c
        n.mb.push(c.id)
      },
    ])
  if (u('close') && s.ph === 'N' && s.L.some((l) => !l.ab))
    A.push([
      'closeWindow(confirm stop)',
      (n) => {
        bump(n, 'close')
        for (const l of n.L.slice()) abortLease(n, l.id, 'close')
      },
    ])
  if (u('quit') && s.ph === 'N')
    A.push([
      'quit',
      (n) => {
        bump(n, 'quit')
        n.quitCards = cardsNow(n)
        n.ph = 'Q'
        for (const l of n.L.slice()) abortLease(n, l.id, 'quit')
      },
    ])
  if (u('crash'))
    A.push([
      'crash+restart',
      (n) => {
        bump(n, 'crash')
        recover(n, false)
      },
      (n) => {
        recover(n, true)
      },
    ])
  // environment: prebuild completes
  for (const c of Object.values(s.cmds))
    if (c.ph === 'pre' && (!AU.hang || c.preAborted)) {
      // R4 :422 prebuild races lease.signal
      A.push([
        `prebuild#${c.id}(${c.t}) done`,
        (n) => {
          const d = n.cmds[c.id]
          d.pre = d.preAborted ? 'aborted' : n.wc
          d.ph = 'mb'
          n.mb.push(d.id)
        },
      ])
    }
  // environment: mailbox head
  const mi = nextIndex(s)
  if (mi >= 0) {
    const hc = s.cmds[s.mb[mi]]
    A.push([
      `mailbox:${hc?.t}${hc?.what ? '/' + hc.what : ''}`,
      (n) => (hc && hc.t === 'sendq' ? processHead2(n, mi) : processHead(n, mi)),
    ])
  }
  // environment: run progress
  for (const [rid, r] of Object.entries(s.runs)) {
    if (r.st === 'w' || r.st === 'wait') continue
    const push = (what) =>
      A.push([
        `run${rid}(${r.s}${r.onP ? ',onParent' : ''}) ${what}`,
        (n) => {
          const c = { id: n.nc++, t: 'rw', run: rid, what, prevSt: n.runs[rid].st }
          n.runs[rid].st = 'w'
          n.cmds[c.id] = c
          n.mb.push(c.id)
        },
      ])
    if (r.st === 'abort') {
      push('abortEnd')
      continue
    }
    if (r.onP) {
      push('childDoneP')
      push('childPauseP')
      continue
    }
    push('complete')
    push('pauseA')
    if (r.s === 'R') {
      push('boundary')
      push('error')
      push('pauseQ')
      if (u('spawn'))
        A.push([
          `run${rid} spawn child`,
          (n) => {
            bump(n, 'spawn')
            const c = { id: n.nc++, t: 'rw', run: rid, what: 'spawn', prevSt: 'stream' }
            n.runs[rid].st = 'w'
            n.cmds[c.id] = c
            n.mb.push(c.id)
          },
        ])
    }
  }
  return A
}
// queue.act send-now (queuedId) processing
function processHead2(s, i) {
  const id = s.mb[i || 0]
  const c = s.cmds[id]
  if (c && c.t === 'sendq') {
    s.mb.splice(i || 0, 1)
    delete s.cmds[id]
    const it = s.q.find((x) => x.id === c.qid)
    if (!it) return // not-found
    const target = s.runs[c.urgentRun]
    if (target) {
      // R4/R5 literal :430 still running = run_terminal not committed (a queued write 'w' counts; aborted too)
      abortLease(s, target.lease, 'stop')
      it.u = true
      s.textUrg[it.id] = true
      if (s.held && s.held.qid === it.id) s.held = null // :425 held item taken by 立即发送
    } else {
      // Run already ended: "照普通发送发出，带上排在它前面的项"
      // 「照普通发送发出，带上排在它前面的项」: a send cmd for that item, no prebuild yet
      takeQ(s, (x) => x.id === it.id)
      const d = {
        id: s.nc++,
        t: 'send',
        text: it.id,
        qItem: it,
        lease: null,
        pre: null,
        peekSeq: it.seq - 1,
        ph: 'mb',
      }
      s.cmds[d.id] = d
      s.mb.unshift(d.id)
      processHead(s)
    }
    return
  }
  return processHead(s)
}

function recover(n, tighten) {
  // crash: memory lost
  for (const q of n.q) n.texts[q.id] = 'dropped'
  for (const c of Object.values(n.cmds)) {
    if (c.text && (n.texts[c.text] === 'cmd' || n.texts[c.text] === 'taken'))
      n.texts[c.text] = 'dropped'
    if (c.taken) for (const x of c.taken) n.texts[x.id] = 'dropped'
  }
  n.q = []
  n.held = null
  n.L = []
  n.mb = []
  n.cmds = {}
  n.ph = 'N'
  n.rs = []
  n.stopRecs = []
  n.stopAsked = []
  n.quitCards = null
  const T = n.T
  // (a) runs without terminal: child first
  const cr = childRun(n)
  if (cr) {
    delete n.runs[cr[0]]
    T.C.last = 'recovered'
  }
  const rr = rootRun(n)
  if (rr) {
    delete n.runs[rr[0]]
    if (T.R.agent === 'open' && (T.C.pend || T.C.tight)) T.R.last = 'paused-sub'
    else {
      if (T.R.agent === 'open') T.R.agent = 'uncertain'
      T.R.last = 'recovered'
    }
  }
  // (b) parent paused{subagent} whose child no longer waits
  if (T.R.agent === 'open' && !T.C.pend && !T.C.tight) T.R.agent = 'uncertain'
  // step 2 rejudge (only approval rows), tighten nondeterministically
  if (tighten) {
    if (T.R.pend === 'A') {
      T.R.pend = null
      T.R.tight = true
    }
    if (T.C.pend === 'A') {
      T.C.pend = null
      T.C.tight = true
    }
  }
  // step 4 list resumable from Tape
  if (T.R.tight && T.R.contOf === 0) n.rs.push('R')
  if (T.C.tight && T.C.contOf === 0) n.rs.push('C')
  if (Object.keys(n.runs).length) V('startup-request', 'recover opened a Run', ':428')
}

// ---------- invariants ----------
function check(s) {
  if (s.L.length > 1) V('two-leases', 'more than one live lease on the root', ':418')
  for (const [rid, r] of Object.entries(s.runs))
    if (!leaseById(s, r.lease))
      V('run-without-lease', `run ${rid} (${r.s}) live with no live lease`, ':418,:1690')
  for (const [t, f] of Object.entries(s.texts))
    if (f === 'taken') {
      const owned = Object.values(s.cmds).some(
        (c) => (c.taken && c.taken.some((x) => x.id === t)) || c.text === t,
      )
      if (!owned) V('lost-text', `text ${t} taken from queue but no task owns it`, ':425')
    }
  // resumable set vs Tape
  for (const x of s.rs)
    if (!s.T[x].tight)
      V(
        'stale-resumable',
        `kernel resumable set lists ${x} but a Run already points at its paused Run (approval.list shows a resume row; approval.resume would re-open it)`,
        ':397,:1299,:1462',
      )
  // parent-child
  const T = s.T
  if ((T.C.pend || T.C.tight) && T.R.agent !== 'open')
    V('orphan-child-wait', 'child pending/resumable but parent Agent call not waiting', ':2540')
  const quiet =
    Object.keys(s.runs).length === 0 && Object.keys(s.cmds).length === 0 && s.mb.length === 0
  if (quiet && T.R.agent === 'open' && !T.C.pend && !T.C.tight && s.ph === 'N')
    V(
      'parent-waits-forever',
      'quiescent; parent paused{subagent} but child neither pending, running nor resumable',
      ':2540',
    )
  if (quiet && s.ph === 'N' && s.q.some((x) => x.u))
    V(
      'stuck-urgent',
      'quiescent; an urgent item (sendNow / send while stopping) was never sent',
      ':421,:426,:1461,:2543',
    )
  if (quiet && s.L.length) V('leaked-lease', 'quiescent but a lease is still live', ':418')
  // INV card vs Run
  if (
    (T.R.pend || T.C.pend || RES(s, 'R') || RES(s, 'C')) &&
    Object.values(s.runs).some((r) => r.st !== 'abort' && r.st !== 'w')
  )
    V(
      'card-and-run',
      'a waiting card / resumable item coexists with a live Run: ' + cardsNow(s),
      ':1601,:2540',
    )
  // INV D2 reverse: Tape-resumable => in kernel set
  if (s.ph === 'N')
    for (const x of ['R', 'C'])
      if (RES(s, x) && !s.rs.includes(x))
        V(
          'resumable-missing-from-set',
          `Tape-resumable ${x} not in kernel set (no resume row; resume() returns none)`,
          ':397,:1772',
        )
  if (quiet) {
    const now = cardsNow(s)
    for (const r of s.stopRecs)
      for (const c of r.cards)
        if (now.includes(c))
          V(
            'swallowed-stop:' + r.via,
            `stop returned stopped:true but ${c} still waits`,
            ':424,:1669,:1718',
          )
    if (s.ph === 'Q' && s.quitCards)
      for (const c of s.quitCards)
        if (
          !now.includes(c) &&
          !s.stopAsked.includes(c) &&
          !s.stopRecs.some((r) => r.cards.includes(c))
        )
          V('B4-quit-closed-card', `quit closed ${c}`, ':1748,:423')
  }
  if (
    AU.hang &&
    s.ph === 'N' &&
    s.L.length &&
    s.L[0].ab === 'stop' &&
    Object.values(s.cmds).some((c) => c.ph === 'pre' && c.preLease === s.L[0].id && !c.preAborted)
  )
    V(
      'stuck-after-stop',
      'stop aborted a prebuilding command that keeps waiting on the keychain',
      ':420,:422',
    )
}

// ---------- BFS ----------
function key(s) {
  const k = { ...s }
  delete k.sentLog
  return JSON.stringify(k)
}
function main() {
  let frontier = []
  const seen = new Set()
  const only = process.argv[4] ? new RegExp(process.argv[4]) : null
  for (const [name, s] of inits()) {
    if (only && !only.test(name)) continue
    s.textOrd = {}
    s.textUrg = {}
    s.ordC = 0
    const k = key(s)
    seen.add(k)
    frontier.push({ s, trace: ['init ' + name] })
  }
  let states = frontier.length,
    depth = 0,
    transitions = 0
  for (const f of frontier) {
    curTrace = f.trace
    check(f.s)
  }
  while (frontier.length && depth < MAXDEPTH) {
    const next = []
    for (const { s, trace } of frontier) {
      curTrace = trace
      for (const [label, fn, alt] of actions(s)) {
        for (const g of alt
          ? [
              fn,
              (n) => {
                n.used.crash = (n.used.crash || 0) + 1
                alt(n)
              },
            ]
          : [fn]) {
          const n = clone(s)
          const tr = [...trace, label + (g !== fn ? ' (rejudge tightens)' : '')]
          curTrace = tr
          try {
            g(n)
          } catch (e) {
            V('crash:' + e.message, e.stack.split('\n')[1], '')
            continue
          }
          transitions++
          check(n)
          const k = key(n)
          if (seen.has(k)) continue
          seen.add(k)
          states++
          next.push({ s: n, trace: tr })
        }
      }
    }
    frontier = next
    depth++
    console.error(`depth ${depth}: frontier ${frontier.length}, states ${states}`)
  }
  process.stdout.write(
    JSON.stringify(
      {
        depth,
        states,
        transitions,
        violations: [...viol].map(([k, v]) => Object.assign({ tag: k }, v)),
        undetermined: [...undet].map(([k, v]) => Object.assign({ tag: k }, v)),
      },
      null,
      1,
    ) + '\n',
  )
}
main()
