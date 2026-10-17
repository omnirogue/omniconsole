import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverOmniosCloseScript,
  discoverOmniosDecideScript,
  discoverOmniosDigScript,
  discoverOmniosStartScript
} from './discover-omnios-brief'
import type { DiscoverOmniosRun } from './discover-omnios-page'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), 'discover-start-'))
  folders.push(path)
  return path
}
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()

function sandbox(origin = false) {
  const workspace = temp()
  git(workspace, 'init', '-q')
  git(workspace, 'checkout', '-b', 'main-next')
  git(
    workspace,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'base'
  )
  const commit = git(workspace, 'rev-parse', 'HEAD')
  let remote: string | undefined
  if (origin) {
    remote = temp()
    git(remote, 'init', '--bare', '-q')
    git(workspace, 'remote', 'add', 'origin', remote)
    git(workspace, 'push', '-q', 'origin', 'main-next')
  }
  const run = {
    executionId: 'parent',
    workspaceId: `repo::${workspace}`,
    source: { commit, branch: 'main-next', ...(remote ? { origin: remote } : {}), dirty: false },
    findings: [1, 2].map((n) => ({
      n,
      key: `find.r1.${n}`,
      title: "Fix $(touch pwned) `touch pwned2` 'q'"
    }))
  } as DiscoverOmniosRun
  const folder = temp()
  writeFileSync(join(folder, 'start.sh'), discoverOmniosStartScript(run, workspace))
  writeFileSync(join(folder, 'close.sh'), discoverOmniosCloseScript())
  writeFileSync(join(folder, 'decide.sh'), discoverOmniosDecideScript(run))
  writeFileSync(join(folder, 'dig.sh'), discoverOmniosDigScript(run, workspace))
  writeFileSync(join(folder, 'contract.json'), '{}')
  const cli = join(folder, 'fake-omni')
  writeFileSync(
    cli,
    `#!/bin/sh
printf '%s\\n' "$@" >> calls.txt
if [ "$1" = worktree ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in --name) name="$2"; shift ;; --base-branch) base="$2"; shift ;; esac
    shift
  done
  path="$PWD/$name"
  git -C "$DISCOVER_TEST_WORKSPACE" worktree add --detach "$path" "$base" >&2
  node -e 'console.log(JSON.stringify({ok:true,result:{worktree:{id:"repo::"+process.argv[1],path:process.argv[1]}}}))' "$path"
elif [ "$1" = workflow ]; then
  echo '{"ok":true,"result":{"executionId":"dug-run"}}'
elif [ -f refuse ]; then
  echo '{"ok":false,"error":{"message":"no verified capacity"}}'
else
  echo '{"ok":true,"result":{"operationId":"launch-1","terminal":{"handle":"term-1"}}}'
fi
`
  )
  chmodSync(cli, 0o700)
  const sh = (script: string, ...args: string[]) =>
    execFileSync('sh', [join(folder, script), ...args], {
      env: { ...process.env, ORCA_CLI_COMMAND: cli, DISCOVER_TEST_WORKSPACE: workspace },
      encoding: 'utf8',
      stdio: 'pipe'
    })
  return {
    folder,
    workspace,
    run,
    sh,
    start: (n = '1') => sh('start.sh', n, 'contract.json'),
    calls: () => readFileSync(join(folder, 'calls.txt'), 'utf8'),
    decisions: () =>
      (
        JSON.parse(readFileSync(join(folder, 'decisions.json'), 'utf8')) as {
          decisions: { n: number; key: string; pick: string; receipt?: unknown }[]
        }
      ).decisions.map(({ n, key, pick, receipt }) => ({ n, key, pick, receipt }))
  }
}

describe('Start and its launch receipt', () => {
  it('uses the recorded pushed commit after the workspace moves, quoting titles and replaying once', () => {
    const box = sandbox(true)
    git(box.workspace, 'checkout', '-b', 'another-branch')
    git(
      box.workspace,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'later'
    )
    box.start()
    expect(box.calls()).toContain(`--base-branch\n${box.run.source!.commit}\n`)
    expect(box.calls()).toContain(`--worktree\nid:repo::${join(box.folder, 'discover-parent-1')}\n`)
    expect(git(join(box.folder, 'discover-parent-1'), 'rev-parse', 'HEAD')).toBe(
      box.run.source!.commit
    )
    expect(box.calls()).not.toContain('--project')
    expect(box.calls()).toContain(box.run.findings[0].title)
    expect(existsSync(join(box.folder, 'pwned')) || existsSync(join(box.folder, 'pwned2'))).toBe(
      false
    )
    const before = box.calls()
    expect(box.start()).toContain('already started')
    expect(box.calls()).toBe(before)
    expect(() => box.start('3')).toThrow()
  })

  it('refuses an unpushed Discover commit without creating a worktree or launching', () => {
    const box = sandbox(true)
    git(
      box.workspace,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'unpushed'
    )
    box.run.source!.commit = git(box.workspace, 'rev-parse', 'HEAD')
    writeFileSync(join(box.folder, 'start.sh'), discoverOmniosStartScript(box.run, box.workspace))
    expect(() => box.start()).toThrow(/not pushed/)
    expect(existsSync(join(box.folder, 'calls.txt'))).toBe(false)
  })

  it('creates a separate local worktree per finding without an origin', () => {
    const box = sandbox()
    box.start('1')
    box.start('2')
    expect(box.calls()).toContain('discover-parent-1')
    expect(box.calls()).toContain('discover-parent-2')
    expect(box.calls()).not.toContain(`path:${box.workspace}`)
    expect(box.calls().match(/worktree\ncreate/g)).toHaveLength(2)
  })

  it('blocks dirty, legacy and plain-folder source instead of sharing a checkout', () => {
    const box = sandbox()
    for (const source of [undefined, { ...box.run.source!, dirty: true }]) {
      writeFileSync(
        join(box.folder, 'start.sh'),
        discoverOmniosStartScript({ ...box.run, source }, box.workspace)
      )
      expect(() => box.start()).toThrow(/Start blocked/)
    }
    expect(existsSync(join(box.folder, 'calls.txt'))).toBe(false)
  })

  it('keeps a refused Start blocked, reuses its worktree on retry, and closes only with a receipt', () => {
    const box = sandbox()
    writeFileSync(join(box.folder, 'refuse'), '')
    expect(() => box.start()).toThrow(/missing launch receipt/)
    expect(existsSync(join(box.folder, 'started-1.json'))).toBe(false)
    expect(() => box.sh('close.sh', 'done', '1', '1')).toThrow(/Action blocked/)
    expect(box.calls()).not.toContain('artifacts')
    rmSync(join(box.folder, 'refuse'))
    box.start()
    box.sh('close.sh', 'started', '1', '1')
    expect(box.calls().match(/worktree\ncreate/g)).toHaveLength(1)
    expect(box.calls()).toContain('artifacts\nclose\npage.html\n--done')
  })
})

describe('The person’s picks in decisions.json', () => {
  it('records a Start with its launch receipt, and a refused one without', () => {
    const box = sandbox()
    writeFileSync(join(box.folder, 'refuse'), '')
    expect(() => box.start('2')).toThrow(/missing launch receipt/)
    expect(box.decisions()).toEqual([{ n: 2, key: 'find.r1.2', pick: 'start', receipt: undefined }])
    rmSync(join(box.folder, 'refuse'))
    box.start('2')
    expect(box.decisions()).toEqual([
      {
        n: 2,
        key: 'find.r1.2',
        pick: 'start',
        receipt: { operationId: 'launch-1', terminal: 'term-1' }
      }
    ])
  })

  it('records Not now and Dig deeper by number, one row per finding', () => {
    const box = sandbox()
    box.sh('decide.sh', '1', 'not-now')
    writeFileSync(join(box.folder, 'dig.md'), 'What is unsure')
    writeFileSync(join(box.folder, 'words.txt'), 'Dig deeper please')
    box.sh('dig.sh', '2', 'dig.md', 'words.txt', 'Sal')
    // A changed answer replaces the finding's earlier pick.
    box.sh('decide.sh', '1', 'dig')
    expect(box.decisions()).toEqual([
      { n: 1, key: 'find.r1.1', pick: 'dig', receipt: undefined },
      { n: 2, key: 'find.r1.2', pick: 'dig', receipt: { executionId: 'dug-run' } }
    ])
    expect(() => box.sh('decide.sh', '3', 'start')).toThrow()
    expect(() => box.sh('decide.sh', '1', 'maybe')).toThrow()
    expect(existsSync(join(box.folder, 'pwned')) || existsSync(join(box.folder, 'pwned2'))).toBe(
      false
    )
  })
})
