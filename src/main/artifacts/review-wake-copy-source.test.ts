import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listedHead,
  publicRemoteUrl,
  wakeCopyWorkspace,
  wakeCopyWrittenFiles,
  workRelativePath
} from './review-wake-copy-source'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wake-home-'))
  mkdirSync(join(home, 'Work', 'Ops', 'X'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe'
  })
    .toString()
    .trim()

describe('which workspace another computer can have', () => {
  it('takes a folder inside ~/Work and refuses one outside it', async () => {
    expect(await workRelativePath(join(home, 'Work', 'Ops', 'X'), home)).toBe('Ops/X')
    expect(await workRelativePath(join(home, 'Work'), home)).toBe('')
    mkdirSync(join(home, 'Elsewhere'))
    expect(
      await wakeCopyWorkspace({ kind: 'folder', path: join(home, 'Elsewhere') }, home)
    ).toEqual({ refused: 'outside Work' })
    expect(
      await wakeCopyWorkspace({ kind: 'folder', path: join(home, 'Work', 'Ops', 'X') }, home)
    ).toEqual({ workspace: { kind: 'folder', workRelativePath: 'Ops/X' } })
  })

  it('takes a clean git worktree whose branch head is on origin, and says why not otherwise', async () => {
    const remote = join(home, 'remote.git')
    const clone = join(home, 'clone')
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['clone', '-q', remote, clone], { stdio: 'pipe' })
    writeFileSync(join(clone, 'a.txt'), 'a')
    git(clone, 'add', 'a.txt')
    git(clone, 'commit', '-qm', 'a')
    git(clone, 'checkout', '-qb', 'feat')
    git(clone, 'push', '-q', 'origin', 'feat')
    const place = { kind: 'git' as const, path: clone }
    expect(await wakeCopyWorkspace(place, home)).toEqual({
      workspace: {
        kind: 'git',
        remoteUrl: remote,
        branch: 'feat',
        commit: git(clone, 'rev-parse', 'HEAD')
      }
    })
    writeFileSync(join(clone, 'b.txt'), 'b')
    expect(await wakeCopyWorkspace(place, home)).toEqual({ refused: 'uncommitted changes' })
    git(clone, 'add', 'b.txt')
    git(clone, 'commit', '-qm', 'b')
    expect(await wakeCopyWorkspace(place, home)).toEqual({ refused: 'unpushed changes' })
  })

  it('strips a user and password from an https remote only', () => {
    expect(publicRemoteUrl('https://x:ghp_secret@github.com/omnirogue/omni-ide.git')).toBe(
      'https://github.com/omnirogue/omni-ide.git'
    )
    expect(publicRemoteUrl('git@github.com:omnirogue/omni-ide.git')).toBe(
      'git@github.com:omnirogue/omni-ide.git'
    )
    expect(publicRemoteUrl('https://[bad')).toBeNull()
    expect(listedHead('abc\trefs/heads/feat-old\ndef\trefs/heads/feat\n', 'feat')).toBe('def')
  })
})

describe('files the session wrote', () => {
  it('keeps regular files inside the folder, newest first, never credentials or escapes', async () => {
    const folder = join(home, 'Work', 'Ops', 'X')
    writeFileSync(join(folder, 'old.md'), 'old')
    writeFileSync(join(folder, 'new.md'), 'new')
    writeFileSync(join(folder, '.env'), 'SECRET=1')
    writeFileSync(join(folder, '.npmrc'), '//registry/:_authToken=abc')
    writeFileSync(join(folder, 'gcp-service-account.json'), '{}')
    writeFileSync(join(folder, 'deploy.md'), `api_key: sk-ant-${'a'.repeat(50)}`)
    writeFileSync(join(folder, 'config.yaml'), 'x: 1')
    writeFileSync(
      join(folder, 'api.ts'),
      'export type Auth = { token: string }\nconst MAX_RETRIES = 3\n'
    )
    writeFileSync(join(folder, 'stripe.md'), `key: sk_live_${'a'.repeat(24)}`)
    writeFileSync(join(folder, 'db.txt'), 'POSTGRES://app:hunter2@db.internal/app')
    writeFileSync(join(folder, 'hook.md'), `secret: whsec_${'b'.repeat(30)}`)
    writeFileSync(join(home, 'outside.md'), 'no')
    symlinkSync(join(home, 'outside.md'), join(folder, 'link.md'))
    const files = await wakeCopyWrittenFiles(
      [
        join(folder, 'old.md'),
        join(folder, '.env'),
        join(home, 'outside.md'),
        join(folder, 'link.md'),
        join(folder, 'new.md'),
        join(folder, 'missing.md'),
        join(folder, '.npmrc'),
        join(folder, 'gcp-service-account.json'),
        join(folder, 'deploy.md'),
        join(folder, 'config.yaml'),
        join(folder, 'api.ts'),
        join(folder, 'stripe.md'),
        join(folder, 'db.txt'),
        join(folder, 'hook.md')
      ],
      folder
    )
    expect(files.map((file) => file.path)).toEqual(['api.ts', 'new.md', 'old.md'])
  })
})
