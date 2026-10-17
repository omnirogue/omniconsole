import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkoutHandoffBranch } from './handoff-git-checkout'
import { HandoffGitRouteError } from './handoff-git-exec'
import { commitHandoffFilesToBranch, resolveHandoffRemote } from './handoff-git-route'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'

/**
 * Real git, not a mock: the value of this route is the plumbing sequence itself — that a WIP
 * commit lands on the handoff branch, is pushed, and leaves the person's working tree, index and
 * checked-out branch exactly as they were.
 */
let root: string
let origin: string
let sender: string
let receiver: string

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root }
  }).trim()
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'omni-handoff-git-'))
  origin = join(root, 'origin.git')
  sender = join(root, 'sender')
  receiver = join(root, 'receiver')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], {
    env: process.env
  })
  execFileSync('git', ['clone', origin, sender], {
    env: { ...process.env, HOME: root }
  })
  run(['config', 'user.email', 'sal@example.test'], sender)
  run(['config', 'user.name', 'Sal'], sender)
  mkdirSync(join(sender, 'docs'))
  writeFileSync(join(sender, 'docs', 'existing.md'), 'base\n')
  writeFileSync(join(sender, '.gitignore'), 'ignored/\n')
  run(['add', '-A'], sender)
  run(['commit', '-m', 'base'], sender)
  run(['push', '-u', 'origin', 'main'], sender)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('commitHandoffFilesToBranch', () => {
  it('commits and pushes the named files without disturbing the working tree', async () => {
    mkdirSync(join(sender, 'out'), { recursive: true })
    writeFileSync(join(sender, 'out', 'plan.md'), 'the plan\n')
    // Work in flight that must survive the handoff untouched.
    writeFileSync(join(sender, 'docs', 'existing.md'), 'edited but not handed over\n')
    const headBefore = run(['rev-parse', 'HEAD'], sender)
    const branchBefore = run(['rev-parse', '--abbrev-ref', 'HEAD'], sender)
    const statusBefore = run(['status', '--porcelain'], sender)

    const result = await commitHandoffFilesToBranch({
      worktreePath: sender,
      branch: 'handoff/chn_1',
      relPaths: ['out/plan.md'],
      message: 'handoff: chn_1'
    })

    expect(result.branch).toBe('handoff/chn_1')
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/)
    expect(result.baseBranch).toBe('main')
    expect(result.remote).toBe('origin')
    expect(result.pushed).toBe(true)
    // The person's checkout is exactly where it was, including the unstaged edit.
    expect(run(['rev-parse', 'HEAD'], sender)).toBe(headBefore)
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'], sender)).toBe(branchBefore)
    expect(run(['status', '--porcelain'], sender)).toBe(statusBefore)
    expect(readFileSync(join(sender, 'docs', 'existing.md'), 'utf8')).toBe(
      'edited but not handed over\n'
    )
    // The pushed commit carries the handed file and the untouched base, not the in-flight edit.
    expect(run(['show', `${result.sha}:out/plan.md`], sender)).toBe('the plan')
    expect(run(['show', `${result.sha}:docs/existing.md`], sender)).toBe('base')
    expect(run(['rev-parse', 'refs/heads/handoff/chn_1'], origin)).toBe(result.sha)
  })

  it('advances the same branch on a second handoff and keeps the first commit reachable', async () => {
    const first = run(['rev-parse', 'refs/heads/handoff/chn_1'], sender)
    writeFileSync(join(sender, 'out', 'plan.md'), 'the revised plan\n')

    const second = await commitHandoffFilesToBranch({
      worktreePath: sender,
      branch: 'handoff/chn_1',
      relPaths: ['out/plan.md'],
      message: 'handoff: chn_1 again'
    })

    expect(second.sha).not.toBe(first)
    expect(run(['merge-base', '--is-ancestor', first, second.sha], sender)).toBe('')
    expect(run(['show', `${second.sha}:out/plan.md`], sender)).toBe('the revised plan')
  })

  it('carries the work as it stands now, never reverting a file changed since the last handoff', async () => {
    // A second handoff after HEAD moved on. Seeding the commit from the branch tip instead of HEAD
    // would silently hand over the OLD contents of every file changed in between.
    writeFileSync(join(sender, 'docs', 'existing.md'), 'changed on main after the first handoff\n')
    run(['add', 'docs/existing.md'], sender)
    run(['commit', '-m', 'move main forward'], sender)
    writeFileSync(join(sender, 'out', 'plan.md'), 'the third plan\n')

    const third = await commitHandoffFilesToBranch({
      worktreePath: sender,
      branch: 'handoff/chn_1',
      relPaths: ['out/plan.md'],
      message: 'handoff: after main moved'
    })

    expect(run(['show', `${third.sha}:docs/existing.md`], sender)).toBe(
      'changed on main after the first handoff'
    )
    expect(run(['show', `${third.sha}:out/plan.md`], sender)).toBe('the third plan')
    // The earlier handoff is still reachable, so nothing was orphaned.
    expect(run(['merge-base', '--is-ancestor', 'HEAD', third.sha], sender)).toBe('')
  })

  it('reuses the exact tip and verifies its publication on replay', async () => {
    const sha = run(['rev-parse', 'refs/heads/handoff/chn_1'], sender)
    await expect(
      commitHandoffFilesToBranch({
        worktreePath: sender,
        branch: 'handoff/chn_1',
        relPaths: ['out/plan.md'],
        message: 'handoff: chn_1 unchanged'
      })
    ).resolves.toMatchObject({ sha, pushed: true })
    expect(run(['rev-parse', 'refs/heads/handoff/chn_1'], origin)).toBe(sha)
  })

  it('refuses to reset a local branch that carries work the handoff does not contain', async () => {
    const sha = run(['rev-parse', 'refs/heads/handoff/chn_1'], sender)
    const other = join(root, 'receiver-divergent')
    execFileSync('git', ['clone', origin, other], { env: { ...process.env, HOME: root } })
    run(['config', 'user.email', 'uma@example.test'], other)
    run(['config', 'user.name', 'Uma'], other)
    run(['checkout', '-b', 'handoff/chn_1'], other)
    writeFileSync(join(other, 'mine.txt'), 'my own unpushed work\n')
    run(['add', 'mine.txt'], other)
    run(['commit', '-m', 'my own work'], other)
    const mine = run(['rev-parse', 'HEAD'], other)

    await expect(
      checkoutHandoffBranch({ worktreePath: other, remote: 'origin', branch: 'handoff/chn_1', sha })
    ).rejects.toMatchObject({ code: 'checkout_failed' })

    // The refusal is the point: their commit is still there and still on the branch.
    expect(run(['rev-parse', 'refs/heads/handoff/chn_1'], other)).toBe(mine)
    expect(readFileSync(join(other, 'mine.txt'), 'utf8')).toBe('my own unpushed work\n')
  })

  it('refuses paths that escape the repository and unusable branch names', async () => {
    await expect(
      commitHandoffFilesToBranch({
        worktreePath: sender,
        branch: 'handoff/bad',
        relPaths: ['../outside.txt'],
        message: 'nope'
      })
    ).rejects.toBeInstanceOf(HandoffGitRouteError)
    await expect(
      commitHandoffFilesToBranch({
        worktreePath: sender,
        branch: '--upload-pack=touch',
        relPaths: ['out/plan.md'],
        message: 'nope'
      })
    ).rejects.toThrow(/invalid_branch_name/)
    await expect(
      commitHandoffFilesToBranch({
        worktreePath: sender,
        branch: 'handoff/bad',
        relPaths: [],
        message: 'nope'
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('refuses a file git ignores rather than committing it', async () => {
    mkdirSync(join(sender, 'ignored'), { recursive: true })
    writeFileSync(join(sender, 'ignored', 'secret.env'), 'TOKEN=1\n')
    await expect(
      commitHandoffFilesToBranch({
        worktreePath: sender,
        branch: 'handoff/chn_ignored',
        relPaths: ['ignored/secret.env'],
        message: 'should not happen'
      })
    ).rejects.toMatchObject({ code: 'commit_failed' })
  })

  it('resolves the push remote from the checked-out branch', async () => {
    expect(await resolveHandoffRemote(sender)).toBe('origin')
  })

  it('verifies a binary blob at the exact existing Git file ceiling', async () => {
    const bytes = Buffer.alloc(HANDOFF_FILE_MAX_BYTES, 254)
    bytes[0] = 0
    writeFileSync(join(sender, 'ceiling.bin'), bytes)
    const result = await commitHandoffFilesToBranch({
      worktreePath: sender,
      branch: 'handoff/ceiling',
      relPaths: ['ceiling.bin'],
      message: 'ceiling',
      expectations: [
        {
          rel: 'ceiling.bin',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }
      ]
    })
    expect(result.pushed).toBe(true)
    expect(run(['rev-parse', 'refs/heads/handoff/ceiling'], origin)).toBe(result.sha)
  })

  it('stages literal names and publishes through a configured non-origin remote', async () => {
    const names = [
      '-literal.txt',
      '[glob].txt',
      ...(process.platform === 'win32' ? [] : [':(icase)x', 'tab\tname'])
    ]
    const bytes = Buffer.from('chosen exact bytes\n')
    for (const name of names) {
      writeFileSync(join(sender, name), bytes)
    }
    writeFileSync(join(sender, 'x'), 'not chosen\n')
    run(['remote', 'add', 'configured', origin], sender)
    run(['config', 'branch.main.remote', 'configured'], sender)
    try {
      const result = await commitHandoffFilesToBranch({
        worktreePath: sender,
        branch: 'handoff/literal',
        relPaths: names,
        message: 'literal',
        expectations: names.map((rel) => ({
          rel,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }))
      })
      expect(result.remote).toBe('configured')
      expect(result.pushed).toBe(true)
      expect(() => run(['show', `${result.sha}:x`], sender)).toThrow()
    } finally {
      run(['config', 'branch.main.remote', 'origin'], sender)
    }
  })

  it('publishes a replay to the configured push URL and refuses a commit that cannot be fetched', async () => {
    const publication = join(root, 'publication.git')
    run(['init', '--bare', publication], sender)
    const path = join(sender, 'out', 'push-url.txt')
    writeFileSync(path, 'first')
    const input = {
      worktreePath: sender,
      branch: 'handoff/push-url',
      relPaths: ['out/push-url.txt'],
      message: 'push-url'
    }
    const first = await commitHandoffFilesToBranch(input)
    run(['config', 'remote.origin.pushurl', publication], sender)
    try {
      const replay = await commitHandoffFilesToBranch(input)
      expect(replay.sha).toBe(first.sha)
      expect(run(['rev-parse', `refs/heads/${input.branch}`], publication)).toBe(first.sha)
      writeFileSync(path, 'second')
      await expect(commitHandoffFilesToBranch(input)).rejects.toMatchObject({ code: 'push_failed' })
      expect(run(['rev-parse', `refs/heads/${input.branch}`], origin)).toBe(first.sha)
      expect(run(['rev-parse', `refs/heads/${input.branch}`], publication)).not.toBe(first.sha)
    } finally {
      run(['config', '--unset', 'remote.origin.pushurl'], sender)
    }
  })

  it('retries an actual rejected push with the same local commit', async () => {
    const hook = join(origin, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o700)
    const input = {
      worktreePath: sender,
      branch: 'handoff/rejected-push',
      relPaths: ['out/plan.md'],
      message: 'retry'
    }
    try {
      await expect(commitHandoffFilesToBranch(input)).rejects.toMatchObject({ code: 'push_failed' })
    } finally {
      rmSync(hook)
    }
    const sha = run(['rev-parse', `refs/heads/${input.branch}`], sender)
    const result = await commitHandoffFilesToBranch(input)
    expect(result.sha).toBe(sha)
    expect(run(['rev-parse', `refs/heads/${input.branch}`], origin)).toBe(sha)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a selected symlink before publishing',
    async () => {
      symlinkSync('docs/existing.md', join(sender, 'selected-link'))
      const bytes = readFileSync(join(sender, 'docs', 'existing.md'))
      await expect(
        commitHandoffFilesToBranch({
          worktreePath: sender,
          branch: 'handoff/symlink',
          relPaths: ['selected-link'],
          message: 'link',
          expectations: [
            {
              rel: 'selected-link',
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            }
          ]
        })
      ).rejects.toMatchObject({ code: 'source_changed' })
      expect(() => run(['rev-parse', '--verify', 'refs/heads/handoff/symlink'], sender)).toThrow()
    }
  )
})

describe('checkoutHandoffBranch', () => {
  it('refuses inconsistent old-manifest bytes before changing the receiving checkout', async () => {
    const other = join(root, 'receiver-byte-check')
    execFileSync('git', ['clone', origin, other], { env: { ...process.env, HOME: root } })
    const before = run(['rev-parse', 'HEAD'], other)
    const sha = run(['rev-parse', 'refs/heads/handoff/chn_1'], origin)
    const bytes = Buffer.from('the third plan\n')
    for (const expectation of [
      { rel: 'out/plan.md', size: bytes.length, sha256: 'f'.repeat(64) },
      {
        rel: 'absent.txt',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    ]) {
      await expect(
        checkoutHandoffBranch({
          worktreePath: other,
          remote: 'origin',
          branch: 'handoff/chn_1',
          sha,
          expectations: [expectation]
        })
      ).rejects.toMatchObject({ code: 'checkout_failed' })
      expect(run(['rev-parse', 'HEAD'], other)).toBe(before)
      expect(() => run(['rev-parse', '--verify', 'refs/heads/handoff/chn_1'], other)).toThrow()
      expect(existsSync(join(other, 'out', 'plan.md'))).toBe(false)
    }
    await expect(
      checkoutHandoffBranch({
        worktreePath: other,
        remote: 'origin',
        branch: 'handoff/chn_1',
        sha,
        expectations: [
          {
            rel: 'out/plan.md',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex')
          }
        ]
      })
    ).resolves.toMatchObject({ sha })
    expect(readFileSync(join(other, 'out', 'plan.md'))).toEqual(bytes)
  })
  it('puts the handed-over files on the receiving machine at the recorded sha', async () => {
    execFileSync('git', ['clone', origin, receiver], {
      env: { ...process.env, HOME: root }
    })
    const sha = run(['rev-parse', 'refs/heads/handoff/chn_1'], origin)

    const result = await checkoutHandoffBranch({
      worktreePath: receiver,
      remote: 'origin',
      branch: 'handoff/chn_1',
      sha
    })

    expect(result.sha).toBe(sha)
    expect(existsSync(join(receiver, 'out', 'plan.md'))).toBe(true)
    expect(readFileSync(join(receiver, 'out', 'plan.md'), 'utf8')).toBe('the third plan\n')
    expect(run(['rev-parse', 'HEAD'], receiver)).toBe(sha)
  })

  it('refuses a sha the remote does not carry', async () => {
    await expect(
      checkoutHandoffBranch({
        worktreePath: receiver,
        remote: 'origin',
        branch: 'handoff/chn_1',
        sha: 'f'.repeat(40)
      })
    ).rejects.toBeInstanceOf(HandoffGitRouteError)
    await expect(
      checkoutHandoffBranch({
        worktreePath: receiver,
        remote: 'origin',
        branch: 'handoff/chn_1',
        sha: 'not-a-sha'
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
