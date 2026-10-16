/**
 * TEMPORARY (plan step 21, 第四段): measurements taken on the CI runners, removed in the PR's last
 * commit. Runs only where TENON_CI_PROBE=1 (the temporary jobs); skipped everywhere else.
 *  - P2: for 50 refused writes and 50 refused proxy connections (macOS adds 50 refused direct
 *    connections), three passes, the time from the process exit to the violation reaching srt's
 *    store. Result: probe-out/p2-<platform>-<arch>.json.
 *  - x64: which `deny <call> <path>` lines the observer sends for each legacy x86-64 system call
 *    (raw syscall(2) through python3) and for the real tools that make them. Result:
 *    probe-out/x64-capture.json.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DARWIN,
  assertSandboxActive,
  makeDir,
  shq,
  startSandboxRig,
  writeHostFile,
  type SandboxLab,
  type SandboxRig,
} from './support.js'

const ON = process.env['TENON_CI_PROBE'] === '1'
const OUT = process.env['TENON_CI_PROBE_OUT'] ?? 'probe-out'
const TRIALS = Number(process.env['TENON_CI_PROBE_TRIALS'] ?? 50)
const PASSES = Number(process.env['TENON_CI_PROBE_PASSES'] ?? 3)
const WAIT_MS = 3_000

/** The srt key a call's violations carry (support.ts `run`). */
const keyOf = (srtId: string): string => Buffer.from(srtId.slice(0, 100)).toString('utf8')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const round1 = (n: number): number => Math.round(n * 10) / 10

function firstLine(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).split('\n')[0] ?? ''
  } catch (error) {
    return `(${String(error)})`
  }
}

function facts(): Record<string, string> {
  const run = firstLine
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    uname: run('uname', ['-a']),
    ...(DARWIN
      ? { sw_vers: run('sw_vers', ['-productVersion']) }
      : { ldd: run('ldd', ['--version']), bwrap: run('bwrap', ['--version']) }),
  }
}

function stats(list: readonly number[]): Record<string, number | null> {
  const sorted = list.toSorted((a, b) => a - b)
  const at = (q: number): number | null =>
    sorted.length === 0
      ? null
      : (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null)
  return { n: sorted.length, min: at(0), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) }
}

describe.skipIf(!ON)('TEMPORARY CI probe', () => {
  let rig: SandboxRig

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    rig = await startSandboxRig()
    assertSandboxActive(rig.outcome)
  }, 120_000)

  afterAll(async () => {
    await rig?.dispose()
  }, 60_000)

  function labWithOutside(): { lab: SandboxLab; ws: string; outside: string } {
    const lab = rig.lab()
    const ws = lab.dir('ws')
    lab.folders = [ws]
    return { lab, ws, outside: lab.dir('outside') }
  }

  it('P2: violation arrival time', async () => {
    type Kind = {
      kind: string
      command: (outside: string, tag: string) => string
      match: (line: string, outside: string, tag: string) => boolean
    }
    const kinds: Kind[] = [
      {
        kind: 'write',
        command: (outside, tag) => `echo x > ${shq(join(outside, `w-${tag}`))}`,
        match: (line, outside, tag) =>
          line.endsWith(join(outside, `w-${tag}`)) && /deny/.test(line),
      },
      {
        kind: 'proxy-connect',
        command: (_o, tag) =>
          `curl -sS --max-time 5 -o /dev/null http://p2-denied-${tag}.example.invalid/`,
        match: (line, _o, tag) => line.includes(`p2-denied-${tag}.example.invalid`),
      },
      ...(DARWIN
        ? [
            {
              kind: 'direct-connect',
              command: () => `curl --noproxy '*' -sS --max-time 3 -o /dev/null http://1.1.1.1/`,
              match: (line: string) => /deny\(1\) network-outbound/.test(line),
            },
          ]
        : []),
    ]
    const result: Record<string, unknown> = { facts: facts(), trials: TRIALS, passes: PASSES }
    const byKind: Record<string, unknown> = {}
    for (const one of kinds) {
      const pooled: number[] = []
      const perPass: unknown[] = []
      let lostTotal = 0
      for (let pass = 0; pass < PASSES; pass += 1) {
        const { lab, ws, outside } = labWithOutside()
        const deltas: number[] = []
        let lost = 0
        const sideLines = new Set<string>()
        for (let i = 0; i < TRIALS; i += 1) {
          const tag = `${String(pass)}-${String(i)}`
          const before = performance.now()
          // oxlint-disable-next-line no-await-in-loop -- one command after another, as the measurement
          const ran = await lab.run(one.command(outside, tag), { workspace: [ws] })
          const exitedAt = before + ran.ms
          const key = keyOf(ran.srtId)
          const own = (): { at: number; line: string } | undefined =>
            rig.arrivals.find((a) => a.key === key && one.match(a.line, outside, tag))
          const deadline = performance.now() + WAIT_MS
          // oxlint-disable-next-line no-await-in-loop -- polling for this call's own line
          while (own() === undefined && performance.now() < deadline) await sleep(2)
          const first = own()
          if (first === undefined) lost += 1
          else deltas.push(round1(first.at - exitedAt))
          for (const a of rig.arrivals) {
            if (a.key === key && !one.match(a.line, outside, tag)) sideLines.add(a.line)
          }
        }
        lostTotal += lost
        pooled.push(...deltas)
        perPass.push({ pass, lost, ...stats(deltas), sideLines: [...sideLines].slice(0, 5) })
      }
      byKind[one.kind] = { lost: lostTotal, pooled: stats(pooled), perPass, deltas: pooled }
    }
    result['kinds'] = byKind
    const p99s = Object.values(byKind).flatMap((k) => {
      const p = (k as { pooled: { p99: number | null } }).pooled.p99
      return p === null ? [] : [p]
    })
    result['p99'] = p99s.length === 0 ? null : Math.max(...p99s)
    const file = join(OUT, `p2-${process.platform}-${process.arch}.json`)
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
    expect(Object.keys(byKind).length).toBeGreaterThan(0)
    console.warn(
      `CI-PROBE P2 ${file}: p99 ${String(result['p99'])} ms, ${JSON.stringify(byKind, (k, v) => (k === 'deltas' ? undefined : v))}`,
    )
  }, 1_800_000)

  describe.skipIf(!DARWIN)('macOS stop diagnostics', () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- temporary probe
    const hostPs = (needle: string): string[] => {
      try {
        return execFileSync(
          '/bin/ps',
          ['-E', '-ww', '-A', '-o', 'pid=,ppid=,pgid=,stat=,command='],
          {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        )
          .split('\n')
          .filter((row) => row.includes(needle) && !row.includes('/bin/ps'))
          .map((row) =>
            row
              .replace(/ [A-Za-z_][A-Za-z0-9_]*=\S*/g, (m) =>
                m.includes('TENON_SANDBOX_MARK') ? ' <MARK-IN-ENV>' : '',
              )
              .slice(0, 400),
          )
      } catch (error) {
        return [String(error)]
      }
    }

    it('python3 and perl under the sandbox on this runner', async () => {
      const out: Record<string, unknown> = { facts: facts() }
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- temporary probe
      const sh = (script: string): string => {
        try {
          return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).trim()
        } catch (error) {
          return `(${String(error).slice(0, 200)})`
        }
      }
      out['system'] = {
        csrutil: sh('csrutil status 2>&1 | head -2'),
        python3: sh(
          'ls -l /usr/bin/python3 /usr/bin/perl; /usr/bin/python3 -c "import sys; print(sys.executable, sys.version)"; /usr/bin/perl -e \'print "$^V $^X\\n"\'',
        ),
        pythonSigned: sh(
          'codesign -dvv "$(/usr/bin/python3 -c \'import sys; print(sys.executable)\')" 2>&1 | grep -E "Identifier|Platform|flags|Authority" | head -6',
        ),
        whichAll: sh('which -a python3 perl'),
      }
      const { lab, ws } = labWithOutside()
      // A: python3 (setsid) starts perl, stderr kept
      const mark = `DIAGMARK${String(Date.now())}`
      const a = await lab.run(
        [
          `python3 -c 'import os, subprocess, sys, time; os.setsid(); p = subprocess.Popen(["perl", "-e", "sleep 12", sys.argv[1].replace("_setsid", "_perl")]); sys.stderr.write("popen ok %d\\n" % p.pid); sys.stderr.flush(); time.sleep(12)' ${mark}_setsid 2>${shq(join(ws, 'a.err'))} &`,
          'sleep 3',
          `/bin/ps -A -ww -o pid=,ppid=,pgid=,stat=,command= | grep ${mark} | grep -v grep`,
          `echo ---err; cat ${shq(join(ws, 'a.err'))}`,
          'exit 0',
        ].join('\n'),
        { workspace: [ws] },
      )
      out['A_python_starts_perl'] = {
        code: a.code,
        stdout: a.stdout.slice(0, 1500),
        stderr: a.stderr.slice(0, 500),
      }
      await sleep(500)
      out['A_after'] = hostPs(mark)
      // B: a platform perl that setsids; look at the host's ps -E while it runs, then after
      const markB = `DIAGPLAT${String(Date.now())}`
      const running = lab.run(
        [
          `perl -MPOSIX -e 'POSIX::setsid(); sleep 12' ${markB}_setsid >/dev/null 2>&1 &`,
          'sleep 3',
          'exit 0',
        ].join('\n'),
        { workspace: [ws] },
      )
      await sleep(1500)
      out['B_during'] = hostPs(markB)
      await running
      const after: string[][] = []
      for (let i = 0; i < 12; i += 1) {
        after.push(hostPs(markB))
        // oxlint-disable-next-line no-await-in-loop -- sampling over time
        await sleep(250)
      }
      out['B_after_samples'] = after
      const file = join(OUT, 'macos-diag.json')
      writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
      expect(Object.keys(out).length).toBeGreaterThan(0)
      console.warn(`CI-PROBE macOS diag ${file}`)
    }, 300_000)
  })

  describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('x64 capture', () => {
    // x86-64 system call numbers (arch/x86/entry/syscalls/syscall_64.tbl), named as apply-seccomp
    // would name them; a raw syscall(2) makes exactly that call whatever glibc maps it to.
    const SCRIPT = [
      'import ctypes, os, sys',
      'libc = ctypes.CDLL(None, use_errno=True)',
      'libc.syscall.restype = ctypes.c_long',
      'AT, C, S = -100, ctypes.c_long, lambda x: ctypes.c_char_p(x.encode())',
      'nul, uid, gid = ctypes.c_void_p(0), os.getuid(), os.getgid()',
      'how = (ctypes.c_uint64 * 3)(0x41, 0o644, 0)',
      'T = {',
      "  'open': (2, lambda p, q: [S(p), C(0x41), C(0o644)]),",
      "  'truncate': (76, lambda p, q: [S(p), C(0)]),",
      "  'rename': (82, lambda p, q: [S(p), S(q)]),",
      "  'mkdir': (83, lambda p, q: [S(p), C(0o755)]),",
      "  'rmdir': (84, lambda p, q: [S(p)]),",
      "  'creat': (85, lambda p, q: [S(p), C(0o644)]),",
      "  'link': (86, lambda p, q: [S(p), S(q)]),",
      "  'unlink': (87, lambda p, q: [S(p)]),",
      "  'symlink': (88, lambda p, q: [S(p), S(q)]),",
      "  'chmod': (90, lambda p, q: [S(p), C(0o600)]),",
      "  'chown': (92, lambda p, q: [S(p), C(uid), C(gid)]),",
      "  'lchown': (94, lambda p, q: [S(p), C(uid), C(gid)]),",
      "  'utime': (132, lambda p, q: [S(p), nul]),",
      "  'mknod': (133, lambda p, q: [S(p), C(0o10644), C(0)]),",
      "  'utimes': (235, lambda p, q: [S(p), nul]),",
      "  'openat': (257, lambda p, q: [C(AT), S(p), C(0x41), C(0o644)]),",
      "  'mkdirat': (258, lambda p, q: [C(AT), S(p), C(0o755)]),",
      "  'mknodat': (259, lambda p, q: [C(AT), S(p), C(0o10644), C(0)]),",
      "  'fchownat': (260, lambda p, q: [C(AT), S(p), C(uid), C(gid), C(0)]),",
      "  'futimesat': (261, lambda p, q: [C(AT), S(p), nul]),",
      "  'unlinkat': (263, lambda p, q: [C(AT), S(p), C(0)]),",
      "  'renameat': (264, lambda p, q: [C(AT), S(p), C(AT), S(q)]),",
      "  'linkat': (265, lambda p, q: [C(AT), S(p), C(AT), S(q), C(0)]),",
      "  'symlinkat': (266, lambda p, q: [S(p), C(AT), S(q)]),",
      "  'fchmodat': (268, lambda p, q: [C(AT), S(p), C(0o600)]),",
      "  'utimensat': (280, lambda p, q: [C(AT), S(p), nul, C(0)]),",
      "  'renameat2': (316, lambda p, q: [C(AT), S(p), C(AT), S(q), C(0)]),",
      "  'openat2': (437, lambda p, q: [C(AT), S(p), ctypes.byref(how), C(24)]),",
      "  'fchmodat2': (452, lambda p, q: [C(AT), S(p), C(0o600), C(0)]),",
      '}',
      'name, p, q = sys.argv[1], sys.argv[2], sys.argv[3]',
      'nr, args = T[name]',
      'r = libc.syscall(C(nr), *args(p, q))',
      "print('ret=%d errno=%d' % (r, ctypes.get_errno()))",
    ].join('\n')
    const RAW: readonly string[] = [
      'open',
      'truncate',
      'rename',
      'mkdir',
      'rmdir',
      'creat',
      'link',
      'unlink',
      'symlink',
      'chmod',
      'chown',
      'lchown',
      'utime',
      'mknod',
      'utimes',
      'openat',
      'mkdirat',
      'mknodat',
      'fchownat',
      'futimesat',
      'unlinkat',
      'renameat',
      'linkat',
      'symlinkat',
      'fchmodat',
      'utimensat',
      'renameat2',
      'openat2',
      'fchmodat2',
    ]

    it('which lines the observer sends for each legacy call', async () => {
      const { lab, ws, outside } = labWithOutside()
      // What the real tools find on the host: files to remove, move, link, chmod, chown, truncate.
      writeHostFile(join(outside, 'f-rm'), 'x\n')
      makeDir(join(outside, 'd-rmdir'))
      writeHostFile(join(outside, 'a-mv'), 'x\n')
      writeHostFile(join(outside, 'src-ln'), 'x\n')
      writeHostFile(join(outside, 'f-chmod'), 'x\n')
      writeHostFile(join(outside, 'f-chown'), 'x\n')
      writeHostFile(join(outside, 'f-trunc'), 'x\n')
      makeDir(join(outside, 'existing'))
      const rows: unknown[] = []
      const record = async (via: string, label: string, command: string): Promise<void> => {
        const ran = await lab.run(command, { workspace: [ws] })
        await sleep(300)
        const key = keyOf(ran.srtId)
        rows.push({
          via,
          label,
          code: ran.code,
          stdout: ran.stdout.trim().slice(0, 200),
          stderr: ran.stderr.trim().slice(0, 200),
          raw: rig.arrivals.filter((a) => a.key === key).map((a) => a.line),
          classified: ran.violations.map((v) => v.line),
        })
      }
      for (const name of RAW) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, each its own command
        await record(
          'raw',
          name,
          `/usr/bin/python3 -c ${shq(SCRIPT)} ${name} ${shq(join(outside, `${name}-p`))} ${shq(join(outside, `${name}-q`))}`,
        )
      }
      // mkdir on a directory that exists, raw
      await record(
        'raw',
        'mkdir-existing',
        `/usr/bin/python3 -c ${shq(SCRIPT)} mkdir ${shq(outside)} ${shq(outside)}`,
      )
      await record(
        'raw',
        'mkdirat-existing',
        `/usr/bin/python3 -c ${shq(SCRIPT)} mkdirat ${shq(outside)} ${shq(outside)}`,
      )
      const o = (name: string): string => shq(join(outside, name))
      const tools: [string, string][] = [
        ['mkdir -p (existing)', `mkdir -p ${shq(outside)}`],
        ['mkdir -p (existing, deeper)', `mkdir -p ${o('existing')}/n4`],
        ['mkdir -p (new, two levels)', `mkdir -p ${o('n1')}/n2`],
        ['mkdir (new)', `mkdir ${o('n3')}`],
        ['touch (new)', `touch ${o('t-new')}`],
        ['touch (existing)', `touch ${o('f-chmod')}`],
        ['echo > (new)', `echo x > ${o('e-new')}`],
        ['rm', `rm ${o('f-rm')}`],
        ['rmdir', `rmdir ${o('d-rmdir')}`],
        ['mv', `mv ${o('a-mv')} ${o('b-mv')}`],
        ['ln -s', `ln -s target ${o('l-sym')}`],
        ['ln', `ln ${o('src-ln')} ${o('l-hard')}`],
        ['chmod', `chmod 600 ${o('f-chmod')}`],
        ['chown', `chown $(id -u) ${o('f-chown')}`],
        ['truncate', `truncate -s 0 ${o('f-trunc')}`],
        ['mknod', `mknod ${o('n-fifo')} p`],
        ['cp', `cp /etc/hostname ${o('c-cp')}`],
        ['install -d', `install -d ${o('i-dir')}`],
        [
          'python os.mkdir',
          `/usr/bin/python3 -c "import os,sys; os.mkdir(sys.argv[1])" ${o('py-dir')}`,
        ],
        [
          'python os.makedirs exist_ok',
          `/usr/bin/python3 -c "import os,sys; os.makedirs(sys.argv[1], exist_ok=True)" ${shq(outside)}`,
        ],
      ]
      for (const [label, command] of tools) {
        // oxlint-disable-next-line no-await-in-loop -- one command at a time
        await record('tool', label, `${command}; echo rc=$?`)
      }
      const file = join(OUT, 'x64-capture.json')
      writeFileSync(file, `${JSON.stringify({ facts: facts(), outside, rows }, null, 2)}\n`)
      expect(rows.length).toBeGreaterThan(0)
      console.warn(`CI-PROBE x64 ${file}: ${String(rows.length)} rows`)
    }, 900_000)
  })
})
