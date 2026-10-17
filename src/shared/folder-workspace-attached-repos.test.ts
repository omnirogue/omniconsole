import { describe, expect, it } from 'vitest'
import type { Repo } from './repo-types'
import {
  withAttachedRepo,
  buildFolderWorkspaceAttachedRepo,
  getAttachedRepoKey,
  normalizeFolderWorkspaceAttachedRepos,
  resolveAttachedRepo,
  selectAttachedRepoForCreate
} from './folder-workspace-attached-repos'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/work/omni-ide',
    displayName: 'omni-ide',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/omnirogue/omni-ide',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/omnirogue/omni-ide.git'
    },
    ...overrides
  }
}

describe('attached repo identity', () => {
  it('keys on git identity plus host, so two clones on one host share a key and hosts never merge', () => {
    const local = repo()
    const otherClone = repo({ id: 'repo-2', path: '/elsewhere/omni-ide' })
    const remote = repo({ id: 'repo-3', connectionId: 'ssh-box' })
    expect(getAttachedRepoKey(local)).toBe('local|github.com/omnirogue/omni-ide')
    expect(getAttachedRepoKey(otherClone)).toBe(getAttachedRepoKey(local))
    expect(getAttachedRepoKey(remote)).not.toBe(getAttachedRepoKey(local))
  })

  it('falls back to the checkout path when the repo has no remote', () => {
    expect(getAttachedRepoKey(repo({ gitRemoteIdentity: null }))).toMatch(/^local\|path:/)
  })

  it('keeps resolving by repo id after the repo gains a remote identity (review F3)', () => {
    const pathOnly = repo({ gitRemoteIdentity: null })
    const attachment = buildFolderWorkspaceAttachedRepo(pathOnly, 'manual', 1)
    expect(resolveAttachedRepo(attachment, [repo()])?.id).toBe('repo-1')
  })

  it('normalizes checkout paths in path identities (review F8)', () => {
    const a = repo({ gitRemoteIdentity: null, path: '/work/omni-ide/' })
    const b = repo({ gitRemoteIdentity: null, path: '/work/omni-ide' })
    expect(getAttachedRepoKey(a)).toBe(getAttachedRepoKey(b))
  })

  it('re-resolves a stale repo id to the same identity on the same host', () => {
    const attachment = buildFolderWorkspaceAttachedRepo(repo(), 'manual', 1)
    const reAdded = repo({ id: 'repo-new' })
    expect(resolveAttachedRepo(attachment, [reAdded])?.id).toBe('repo-new')
    expect(
      resolveAttachedRepo(attachment, [repo({ id: 'x', connectionId: 'ssh' })])
    ).toBeUndefined()
  })
})

describe('normalizeFolderWorkspaceAttachedRepos', () => {
  it('keeps valid rows, drops malformed ones and duplicate keys, and tolerates old profiles', () => {
    const good = buildFolderWorkspaceAttachedRepo(repo(), 'first-worktree', 5)
    expect(normalizeFolderWorkspaceAttachedRepos(undefined)).toEqual({})
    expect(normalizeFolderWorkspaceAttachedRepos([good])).toEqual({})
    expect(
      normalizeFolderWorkspaceAttachedRepos({
        f1: [good, { ...good }, { key: 'x' }, null],
        f2: 'nope',
        f3: []
      })
    ).toEqual({ f1: [good] })
  })
})

describe('selectAttachedRepoForCreate', () => {
  const a = buildFolderWorkspaceAttachedRepo(repo(), 'manual', 1)
  const b = buildFolderWorkspaceAttachedRepo(
    repo({ id: 'r2', displayName: 'adsmanager', path: '/w/ads', gitRemoteIdentity: null }),
    'manual',
    1
  )

  it('uses the only attached repo when no name is given', () => {
    expect(selectAttachedRepoForCreate([a], undefined)).toEqual({ kind: 'match', attachment: a })
  })

  it('asks for --repo when several are attached', () => {
    expect(selectAttachedRepoForCreate([a, b], undefined)).toEqual({
      kind: 'ambiguous',
      names: ['omni-ide', 'adsmanager']
    })
  })

  it('matches a name by display name or identity tail, case-insensitively', () => {
    expect(selectAttachedRepoForCreate([a, b], 'ADSMANAGER')).toMatchObject({
      kind: 'match',
      attachment: b
    })
    expect(selectAttachedRepoForCreate([a, b], 'omni-ide')).toMatchObject({
      kind: 'match',
      attachment: a
    })
    expect(selectAttachedRepoForCreate([a], 'other')).toEqual({ kind: 'no-match' })
    expect(selectAttachedRepoForCreate([], undefined)).toEqual({ kind: 'none-attached' })
  })
})

describe('withAttachedRepo (review N4)', () => {
  it('keeps one row per key, the earliest, when an enriched repo meets an existing row', () => {
    const pathOnly = buildFolderWorkspaceAttachedRepo(
      repo({ gitRemoteIdentity: null }),
      'manual',
      1
    )
    const clone = buildFolderWorkspaceAttachedRepo(
      repo({ id: 'repo-clone', path: '/other/omni-ide' }),
      'detected-checkout',
      2
    )
    const enriched = buildFolderWorkspaceAttachedRepo(repo(), 'first-worktree', 3)
    const next = withAttachedRepo([pathOnly, clone], enriched)!
    expect(next.filter((entry) => entry.key === enriched.key)).toHaveLength(1)
    expect(next[0]).toMatchObject({ key: enriched.key, attachedAt: 1, source: 'manual' })
  })
})

describe('legacy path identities (review R8)', () => {
  it('re-normalizes stored path identities so they match a re-registered checkout', () => {
    const stored = {
      ...buildFolderWorkspaceAttachedRepo(repo({ gitRemoteIdentity: null }), 'manual', 1),
      key: 'local|path:/work/omni-ide/',
      gitIdentity: 'path:/work/omni-ide/'
    }
    const [loaded] = normalizeFolderWorkspaceAttachedRepos({ f1: [stored] }).f1
    expect(loaded.key).toBe(getAttachedRepoKey(repo({ gitRemoteIdentity: null })))
  })
})
