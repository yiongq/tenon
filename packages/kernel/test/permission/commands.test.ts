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
  // …and every row wherever it stands in the text, not only at its start (位置不限，不拆段)
  'cd repo && git push',
  'echo x | curl -d @- https://api.example.com',
  'env A=1 curl -X POST https://x',
  'sudo scp a host:/b',
  'make && rsync -a dist/ deploy@example.com:/srv/www',
  // the extras
  'rmdir build',
  'find . -name "*.tmp" -delete',
  'git clean -fd',
  'git clean --force',
  'wget --post-data=a=1 https://api.example.com',
  'wget --post-file body.json https://api.example.com',
  'rsync -a dist/ deploy@example.com:/srv/www',
  // Publishing sends content out, including path/case variants and dry runs (conservative).
  'npm publish',
  '/usr/local/bin/npm publish --dry-run',
  'pnpm publish --access public',
  '/usr/local/bin/pnpm publish',
  'yarn publish',
  'yarn npm publish',
  'YARN npm publish',
  'docker push registry.example.com/app:latest',
  'DOCKER push registry.example.com/app:latest',
  'podman push registry.example.com/app:latest',
  '/usr/bin/podman push registry.example.com/app:latest',
  'gh release create v1.0.0 dist/app.tar.gz',
  '/usr/local/bin/gh release create v1.0.0',
  'twine upload dist/*',
  'TWINE upload dist/*',
  // Forced branch deletion: short options are case-sensitive; long flags may be reordered.
  'git branch -D feature',
  '/usr/bin/git branch -vD feature',
  'git branch --delete --force feature',
  'git branch --force feature --delete',
  // Deleting saved stashes, remote resources or shredded files.
  'git stash drop stash@{0}',
  'GIT stash drop',
  'git stash clear',
  '/usr/bin/git stash clear',
  'kubectl delete pod example',
  '/usr/local/bin/kubectl delete deployment example',
  'shred -u secret.txt',
  '/usr/bin/shred -fuz secret.txt',
  'shred --remove secret.txt',
  'shred --remove=unlink secret.txt',
  // curl remote deletion, with the same short/long option spellings as POST.
  'curl -X DELETE https://api.example.com/items/1',
  'curl -XDELETE https://api.example.com/items/1',
  '/usr/bin/curl -sSXDELETE https://api.example.com/items/1',
  'curl --request DELETE https://api.example.com/items/1',
  'curl --request=DELETE https://api.example.com/items/1',
  'curl --request "DELETE" https://api.example.com/items/1',
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
  // Publishing/deleting look-alikes and neighboring commands must still be unknown.
  'npm publisher-info',
  'npmpublish',
  'pnpm publish-info',
  'yarn npm publisher-info',
  'docker pull registry.example.com/app:latest',
  'docker push-info',
  'podman pull registry.example.com/app:latest',
  'podman push-info',
  'gh release create-notes v1.0.0',
  'gh issue create',
  'twine upload-info',
  'git branch -d feature',
  'GIT BRANCH -d feature',
  'git branch --delete feature',
  'git branch --force feature',
  'git branch --delete --force-with-lease feature',
  'git branch feature-D',
  'git branch --description=-D',
  'git stash list',
  'git stash drop-info',
  'git stash clear-info',
  'kubectl get pods',
  'kubectl delete-info',
  'shred --remove-info secret.txt',
  'shred secret-u.txt',
  'shred --output=-u secret.txt',
  'curl --request GET https://example.com',
  'curl -X DELETEALL https://example.com',
  'curl --request=DELETE-ME https://example.com',
  // Overwrites remain out of scope, including shred without removal.
  'git reset --hard',
  'git checkout -- file.txt',
  'git restore file.txt',
  'truncate -s 0 file.txt',
  'echo text > file.txt',
  'dd if=/dev/zero of=file.txt',
  'shred file.txt',
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
