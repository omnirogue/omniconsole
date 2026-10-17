import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findClaimerWorkspace,
  prepareClaimerBranch,
  remoteIdentity,
  restoreWrittenFiles
} from './review-wake-claimer-workspace'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claimer-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe'
  })
    .toString()
    .trim()

const EMPTY = { repos: [], folders: [], groups: [] }

describe('the workspace a moved session runs in here', () => {
  it('matches clones of one repository however the remote is spelled', () => {
    expect(remoteIdentity('git@github.com:omnirogue/omni-ide.git')).toBe(
      'github.com/omnirogue/omni-ide'
    )
    expect(remoteIdentity('https://GitHub.com/omnirogue/omni-ide')).toBe(
      'github.com/omnirogue/omni-ide'
    )
    expect(remoteIdentity('ssh://git@github.com/omnirogue/omni-ide.git/')).toBe(
      'github.com/omnirogue/omni-ide'
    )
  })

  it('uses the ~/Work folder workspace, or a project above it, and refuses otherwise', async () => {
    const folder = join(home, 'Work', 'Ops', 'X')
    mkdirSync(folder, { recursive: true })
    const required = { kind: 'folder' as const, workRelativePath: 'Ops/X' }
    expect(await findClaimerWorkspace(required, EMPTY, home)).toMatchObject({ refusal: /project/ })
    expect(
      await findClaimerWorkspace(
        required,
        { ...EMPTY, groups: [{ id: 'g', parentPath: join(home, 'Work'), connectionId: null }] },
        home
      )
    ).toMatchObject({ kind: 'folder', workspaceId: null, projectGroupId: 'g' })
    expect(
      await findClaimerWorkspace(
        required,
        { ...EMPTY, folders: [{ id: 'w', folderPath: folder, connectionId: null }] },
        home
      )
    ).toMatchObject({ kind: 'folder', workspaceId: 'w' })
    expect(
      await findClaimerWorkspace({ kind: 'folder', workRelativePath: 'Gone' }, EMPTY, home)
    ).toMatchObject({ refusal: /not on this computer/ })
    // A path from another computer never leaves ~/Work, however it is spelled.
    mkdirSync(join(home, 'Private'))
    const everything = { ...EMPTY, groups: [{ id: 'g', parentPath: home, connectionId: null }] }
    expect(
      await findClaimerWorkspace(
        { kind: 'folder', workRelativePath: '../Private' },
        everything,
        home
      )
    ).toMatchObject({ refusal: /not inside/ })
  })

  it('returns a registered folder workspace by the path it was registered with', async () => {
    const folder = join(home, 'Work', 'Ops', 'X')
    mkdirSync(folder, { recursive: true })
    const spelled = `${join(home, 'Work')}/./Ops/X`
    expect(
      await findClaimerWorkspace(
        { kind: 'folder', workRelativePath: 'Ops/X' },
        { ...EMPTY, folders: [{ id: 'w', folderPath: spelled, connectionId: null }] },
        home
      )
    ).toMatchObject({ kind: 'folder', path: spelled, workspaceId: 'w' })
  })

  it('uses a clone here only while origin’s branch is at the commit it slept on', async () => {
    const remote = join(home, 'remote.git')
    const source = join(home, 'source')
    const here = join(home, 'here')
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['clone', '-q', remote, source], { stdio: 'pipe' })
    writeFileSync(join(source, 'a.txt'), 'a')
    git(source, 'add', 'a.txt')
    git(source, 'commit', '-qm', 'a')
    git(source, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    git(source, 'checkout', '-qb', 'feat')
    git(source, 'push', '-q', 'origin', 'feat')
    const commit = git(source, 'rev-parse', 'HEAD')
    execFileSync('git', ['clone', '-q', remote, here], { stdio: 'pipe' })
    const repos = [{ id: 'r', path: here, kind: 'git', connectionId: null } as never]
    const required = { kind: 'git' as const, remoteUrl: remote, branch: 'feat', commit }
    const found = await findClaimerWorkspace(required, { ...EMPTY, repos }, home)
    expect(found).toMatchObject({ kind: 'git', branch: 'feat', commit })
    // Checked out here already: refused when only one clone exists, or falls back to a second clean clone.
    git(here, 'checkout', '-qb', 'feat', 'origin/feat')
    expect(await findClaimerWorkspace(required, { ...EMPTY, repos }, home)).toMatchObject({
      refusal: /already checked out/
    })
    const secondClone = join(home, 'here-2')
    execFileSync('git', ['clone', '-q', remote, secondClone], { stdio: 'pipe' })
    const twoRepos = [
      ...repos,
      { id: 'r2', path: secondClone, kind: 'git', connectionId: null } as never
    ]
    expect(await findClaimerWorkspace(required, { ...EMPTY, repos: twoRepos }, home)).toMatchObject(
      {
        kind: 'git',
        repo: { id: 'r2', path: secondClone },
        branch: 'feat',
        commit
      }
    )
    git(here, 'checkout', '-q', '--detach')
    git(here, 'branch', '-qD', 'feat')
    await prepareClaimerBranch(found as never)
    expect(git(here, 'rev-parse', 'refs/heads/feat')).toBe(commit)
    writeFileSync(join(source, 'b.txt'), 'b')
    git(source, 'add', 'b.txt')
    git(source, 'commit', '-qm', 'b')
    git(source, 'push', '-q', 'origin', 'feat')
    expect(await findClaimerWorkspace(required, { ...EMPTY, repos }, home)).toMatchObject({
      refusal: /no longer at the commit/
    })
  })

  it('refuses a local branch with other commits, or one checked out here already', async () => {
    const repo = join(home, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'a')
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'remote', 'add', 'origin', repo)
    git(repo, 'checkout', '-qb', 'feat')
    const workspace = {
      kind: 'git' as const,
      repo: { id: 'r', path: repo },
      branch: 'feat',
      commit: base
    }
    await expect(prepareClaimerBranch(workspace)).rejects.toThrow(/already checked out/)
    git(repo, 'checkout', '-q', '--detach')
    writeFileSync(join(repo, 'b.txt'), 'b')
    git(repo, 'add', 'b.txt')
    git(repo, 'commit', '-qm', 'b')
    git(repo, 'branch', '-f', 'feat', 'HEAD')
    await expect(prepareClaimerBranch(workspace)).rejects.toThrow(/has commits/)
  })
})

describe('files the session wrote', () => {
  it('are restored only where missing or unchanged; newer files here stay', async () => {
    const folder = join(home, 'folder')
    const written = join(home, 'written')
    mkdirSync(join(written, 'notes'), { recursive: true })
    mkdirSync(folder)
    for (const name of ['new.md', 'same.md', 'changed.md']) {
      writeFileSync(join(written, 'notes', name), `copy ${name}`)
    }
    mkdirSync(join(folder, 'notes'))
    writeFileSync(join(folder, 'notes', 'same.md'), 'copy same.md')
    writeFileSync(join(folder, 'notes', 'changed.md'), 'edited here later')
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const kept = await restoreWrittenFiles(
      {
        written: ['new.md', 'same.md', 'changed.md'].map((name) => ({
          path: `notes/${name}`,
          bytes: `copy ${name}`.length,
          sha256: sha(`copy ${name}`)
        }))
      },
      written,
      folder
    )
    expect(kept).toEqual(['notes/changed.md'])
    expect(readFileSync(join(folder, 'notes', 'new.md'), 'utf8')).toBe('copy new.md')
    expect(readFileSync(join(folder, 'notes', 'changed.md'), 'utf8')).toBe('edited here later')
  })

  it('overwrites unmodified tracked files on a git worktree while keeping locally modified tracked files', async () => {
    const repo = join(home, 'git-worktree')
    const written = join(home, 'written-git')
    mkdirSync(repo, { recursive: true })
    mkdirSync(written, { recursive: true })
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'clean.ts'), 'base clean')
    writeFileSync(join(repo, 'dirty.ts'), 'base dirty')
    git(repo, 'add', 'clean.ts', 'dirty.ts')
    git(repo, 'commit', '-qm', 'init')
    const commit = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'dirty.ts'), 'modified locally on claimer')
    writeFileSync(join(written, 'clean.ts'), 'uncommitted session change')
    writeFileSync(join(written, 'dirty.ts'), 'uncommitted session dirty')
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const kept = await restoreWrittenFiles(
      {
        workspace: {
          kind: 'git',
          remoteUrl: 'https://github.com/omnirogue/omni-ide.git',
          branch: 'feat',
          commit
        },
        written: [
          {
            path: 'clean.ts',
            bytes: 'uncommitted session change'.length,
            sha256: sha('uncommitted session change')
          },
          {
            path: 'dirty.ts',
            bytes: 'uncommitted session dirty'.length,
            sha256: sha('uncommitted session dirty')
          }
        ]
      },
      written,
      repo
    )
    expect(kept).toEqual(['dirty.ts'])
    expect(readFileSync(join(repo, 'clean.ts'), 'utf8')).toBe('uncommitted session change')
    expect(readFileSync(join(repo, 'dirty.ts'), 'utf8')).toBe('modified locally on claimer')
  })
})
