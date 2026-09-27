/**
 * The command pattern table (spec 02 §可逆性「命令的保守模式表」; plan step 22: 旧 52, invariant 22,
 * acceptance 40): a substring or regex match anywhere in the command text, not a shell parser. A hit
 * is `irreversible`, anything else `unknown`, never `read-only`; the reason is always `command`.
 */
import { describe, expect, it } from 'vitest'
import { absolutePath } from '../../src/index.js'
import { callReasonOf, reversibilityOf } from '../../src/permission/reversibility.js'

const BASH = { source: 'builtin', originalName: 'Bash' } as const

function judged(command: string): string {
  return reversibilityOf(BASH, { command })
}

/** The rows the spec names (E1, E4), then the plan's extras a pattern can tell without `stat`. */
const IRREVERSIBLE: readonly string[] = [
  // rm, wherever it stands — even quoted (「`echo "rm x"` 同样命中」)
  'rm existing.txt',
  'rm -rf build',
  '/bin/rm notes.md',
  'sudo rm /tmp/x',
  'ls && rm a.txt',
  "find . -name '*.o' -exec rm {} \\;",
  'echo "rm x"',
  // curl with -X POST, -d, -F or --upload-file, in their spellings
  'curl -X POST https://api.example.com/items',
  'curl -XPOST https://api.example.com/items',
  'curl --request POST https://api.example.com/items',
  "curl -d 'a=1' https://api.example.com",
  'curl -sSd a=1 https://api.example.com',
  'curl --data-binary @body.json https://api.example.com',
  'curl -F file=@a.png https://api.example.com/upload',
  'curl --form a=b https://api.example.com',
  'curl --upload-file a.txt https://api.example.com/a.txt',
  'curl -T a.txt https://api.example.com/a.txt',
  // git push, scp
  'git push',
  'git push origin main',
  'git -C repo push --force',
  'scp report.pdf host:/srv/report.pdf',
  // the extras
  'rmdir build',
  'find . -name "*.tmp" -delete',
  'git clean -fd',
  'git clean --force',
  'wget --post-data=a=1 https://api.example.com',
  'wget --post-file body.json https://api.example.com',
  'rsync -a dist/ deploy@example.com:/srv/www',
]

const UNKNOWN: readonly string[] = [
  // curl GET, ls, and commands no pattern names
  'curl https://example.com',
  'curl -fsSL https://example.com -o page.html',
  'curl -X GET https://example.com',
  'curl -D headers.txt https://example.com',
  'ls',
  'ls -la',
  'git status',
  'git clean -n',
  'wget https://example.com/file.zip',
  'rsync -a src/ backup/',
  // rm only as a command word: not inside another word, a file name or an option
  'cat form.txt',
  'perform --all',
  'cat rm.txt',
  'docker run --rm alpine true',
  // an mv that may overwrite a file needs a stat to tell, so the table leaves it alone
  'mv draft.md final.md',
  // commands the shell could not even parse
  "if [ ; then echo 'unterminated",
  '(((',
]

describe('the command pattern table (旧 52, invariant 22)', () => {
  it('judges rm, curl with a body or a POST, git push, scp and the extras irreversible', () => {
    // The commands it misses, named, rather than a bare count.
    expect(IRREVERSIBLE.filter((command) => judged(command) !== 'irreversible')).toEqual([])
  })

  it('judges curl GET, ls, look-alikes and unparseable commands unknown', () => {
    expect(UNKNOWN.filter((command) => judged(command) !== 'unknown')).toEqual([])
  })

  it('never judges a command read-only, and always gives the reason command', () => {
    const workspace = absolutePath('/work/project')
    for (const command of [...IRREVERSIBLE, ...UNKNOWN, 'true', 'pwd', 'cat README.md']) {
      expect(judged(command)).not.toBe('read-only')
      expect(callReasonOf({ tool: BASH, args: { command }, workspace, searchHost: null })).toEqual({
        reason: 'command',
        facts: { command, cwd: workspace, toolName: 'Bash' },
      })
    }
  })
})
