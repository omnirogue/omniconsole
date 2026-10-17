import { describe, expect, it, vi } from 'vitest'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  findSessionOwner,
  sessionOwnerProjectId,
  type SessionOwnerDeps,
  type SessionOwnerObserved
} from './session-manage-owner'
import type { LiveSession } from './session-manage-conflicts'
import type { SessionOwnerJudgement } from './session-manage-owner-jev'
import { sessionOwnerLoad } from './session-manage-owner-load'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

const TASK = 'Add retry with backoff to the Meta ads report fetcher'

function session(
  paneKey: string,
  row: Partial<SessionManageSidebarRow> = {},
  entry: Partial<SessionManageEntry> = {},
  bound = false
): SessionOwnerObserved {
  const tabId = paneKey.split(':')[0]!
  return {
    row: sidebarRow({ paneKey, tabId, rowKey: `row-${paneKey}`, title: paneKey, ...row }),
    entry: manageEntry({ paneKey, tabId, title: paneKey, ...entry }),
    bound
  }
}

type Score = number | SessionOwnerJudgement

/**
 * JEV answers by the session title (a number is `related` with no duplicate); a title missing
 * from `scores` is a failed call. `changed` is each worktree's uncommitted files, or unreadable.
 */
function deps(
  scores: Record<string, Score>,
  over: Partial<Omit<SessionOwnerDeps, 'judge' | 'changes'>> = {},
  changed: Record<string, string[] | 'unreadable'> = {}
): SessionOwnerDeps & { judge: ReturnType<typeof vi.fn>; changes: ReturnType<typeof vi.fn> } {
  const judge = vi.fn(async (_task: string, target: { title: string }) => {
    const score = scores[target.title]
    return score === undefined
      ? { failed: 'JEV is turned off on this computer' }
      : typeof score === 'number'
        ? { related: score, duplicate: 0.1 }
        : score
  })
  const changes = vi.fn(async (live: readonly LiveSession[]) => {
    const worktrees = [...new Set(live.map(({ row }) => row.worktreeId))]
    return {
      changes: worktrees.flatMap((worktreeId) => {
        const files = changed[worktreeId]
        return files && files !== 'unreadable'
          ? [
              {
                worktreeId,
                files,
                repo: 'repo',
                repoId: 'repo',
                path: null,
                branch: null,
                sessions: []
              }
            ]
          : []
      }),
      skipped: [],
      unreadable: worktrees.filter((worktreeId) => changed[worktreeId] === 'unreadable'),
      checkedWorktrees: worktrees.length
    }
  })
  return {
    search: async () => ({ matches: new Map(), searched: true }),
    goal: async (row) => `Build the ${row.title} work`,
    ...over,
    judge,
    changes
  }
}

const inFolder = { folderId: 'folder-ads', folder: 'Ads' }

describe('findSessionOwner', () => {
  it('assigns to an idle same-folder session whose goal the task continues', async () => {
    const d = deps({ 'tab-1:leaf-1': 0.93 })
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', inFolder, { folder: 'Ads' })]
      },
      d
    )
    expect(result.disposition).toBe('assign')
    expect(result.owner).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      light: true,
      related: 0.93,
      signals: ['same-folder'],
      goal: 'Build the tab-1:leaf-1 work'
    })
    expect(result.reason).toContain('give it the task instead of launching')
    expect(d.judge).toHaveBeenCalledWith(TASK, {
      title: 'tab-1:leaf-1',
      goal: 'Build the tab-1:leaf-1 work',
      summary: null
    })
  })

  it('reports a working related session as busy-related, never as the owner to assign', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', inFolder, { state: 'working' })]
      },
      deps({ 'tab-1:leaf-1': 0.95 })
    )
    expect(result.disposition).toBe('busy-related')
    expect(result.owner).toMatchObject({ paneKey: 'tab-1:leaf-1', light: false, load: 'working' })
    expect(result.launchNew).toBe(true)
    expect(result.reason).toContain('launch a new session (parallel work is efficient)')
  })

  it('launches new when the only idle session nearby is doing a different job', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', inFolder)]
      },
      deps({ 'tab-1:leaf-1': 0.12 })
    )
    expect(result.disposition).toBe('launch-new')
    expect(result.owner).toBeUndefined()
    expect(result.candidates[0]).toMatchObject({ related: 0.12, light: true })
  })

  it('treats an unsure JEV reading as not related', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', inFolder)]
      },
      deps({ 'tab-1:leaf-1': 0.7 })
    )
    expect(result.disposition).toBe('launch-new')
  })

  it('launches new with the reason when JEV cannot judge', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', inFolder)]
      },
      deps({})
    )
    expect(result.disposition).toBe('launch-new')
    expect(result.reason).toContain('JEV could not judge')
    expect(result.reason).toContain('JEV is turned off on this computer')
    expect(result.jevError).toBe('JEV is turned off on this computer')
    expect(result.candidates[0]!.related).toBeNull()
  })

  it('never asks JEV about a session sharing nothing with the task', async () => {
    const d = deps({ 'tab-1:leaf-1': 0.99 })
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', { folderId: 'folder-other' })]
      },
      d
    )
    expect(d.judge).not.toHaveBeenCalled()
    expect(result.disposition).toBe('launch-new')
    expect(result.reason).toContain('No live session on this computer shares')
  })

  it('counts a transcript hit joined to a row as a shared topic and passes its summary', async () => {
    const d = deps(
      { 'tab-3:leaf-1': 0.9 },
      {
        search: async () => ({
          matches: new Map([['tab-3:leaf-1', { summary: 'Fixing the Meta report fetcher' }]]),
          searched: true
        })
      }
    )
    const result = await findSessionOwner(
      { task: TASK, scope: {}, observed: [session('tab-3:leaf-1')] },
      d
    )
    expect(result.owner).toMatchObject({ signals: ['transcript-match'] })
    expect(d.judge.mock.calls[0]![1]).toMatchObject({ summary: 'Fixing the Meta report fetcher' })
  })

  it('skips the caller, remote, exited and archived sessions', async () => {
    const d = deps({ self: 1, remote: 1, gone: 1, old: 1 })
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        exclude: new Set(['self:leaf']),
        observed: [
          session('self:leaf', inFolder, { title: 'self' }),
          session('remote:leaf', inFolder, { title: 'remote', hostId: 'ssh:box' }),
          session('gone:leaf', inFolder, { title: 'gone', verdict: 'exited', state: 'exited' }),
          session('old:leaf', inFolder, { title: 'old', archived: true })
        ]
      },
      d
    )
    expect(d.judge).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
  })

  it('never offers a session a routine owns, however related', async () => {
    const d = deps({ 'tab-1:leaf-1': 0.99 })
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', { ...inFolder, routine: true }, { folder: 'Ads' })]
      },
      d
    )
    expect(d.judge).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
    expect(result.owner).toBeFalsy()
  })

  it('says coverage is incomplete when a same-folder session cannot be verified', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-4:leaf-1', { ...inFolder, hostUnavailable: true })]
      },
      deps({})
    )
    expect(result.disposition).toBe('coverage-incomplete')
    expect(result.unchecked).toEqual([
      { paneKey: 'tab-4:leaf-1', title: 'tab-4:leaf-1', reason: 'its host cannot be reached' }
    ])
  })

  it('prefers the free related session over a busier, closer one', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads', worktreeId: 'repo::/w' },
        observed: [
          session('busy:leaf', { ...inFolder, worktreeId: 'repo::/w' }, { state: 'working' }),
          session('free:leaf', inFolder)
        ]
      },
      deps({ 'busy:leaf': 0.99, 'free:leaf': 0.85 })
    )
    expect(result.disposition).toBe('assign')
    expect(result.owner?.paneKey).toBe('free:leaf')
  })

  it('keeps a busy true owner inside the JEV budget and marks overflow unchecked', async () => {
    const idle = Array.from({ length: 5 }, (_, index) =>
      session(`idle-${index}:leaf`, inFolder, { title: `idle-${index}` })
    )
    const busy = session('busy:leaf', inFolder, { title: 'busy-owner', state: 'working' })
    const d = deps({
      ...Object.fromEntries(idle.map((entry) => [entry.entry.title, 0.1])),
      'busy-owner': 0.96
    })
    const result = await findSessionOwner(
      { task: TASK, scope: { folderId: 'folder-ads' }, observed: [...idle, busy] },
      d
    )
    expect(result.disposition).toBe('busy-related')
    expect(result.owner).toMatchObject({ paneKey: 'busy:leaf', related: 0.96, light: false })
    expect(d.judge).toHaveBeenCalledTimes(5)
    expect(result.unchecked).toEqual([
      expect.objectContaining({
        paneKey: expect.any(String),
        reason: 'not judged because the session-owner limit is 5'
      })
    ])
    expect(result.unchecked[0]).not.toHaveProperty('risk')
  })
})

describe('findSessionOwner decision table', () => {
  const FILE_TASK = 'Fix the redirect loop in src/auth/login.ts and cover it in tests'
  const editing = { worktreeId: 'repo::/auth', worktreePath: '/auth' }

  it('duplicate, owner idle: do not launch; assign is the next step', async () => {
    const result = await findSessionOwner(
      { task: TASK, scope: { folderId: 'folder-ads' }, observed: [session('dup:leaf', inFolder)] },
      deps({ 'dup:leaf': { related: 0.95, duplicate: 0.9 } })
    )
    expect(result).toMatchObject({
      disposition: 'duplicate',
      launchNew: false,
      owner: { paneKey: 'dup:leaf', light: true, duplicate: 0.9 }
    })
    expect(result.recommend).toContain('omni session assign --pane dup:leaf')
  })

  it('duplicate, owner working: do not launch; ask the owner', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('dup:leaf', inFolder, { state: 'working' })]
      },
      deps({ 'dup:leaf': { related: 0.95, duplicate: 0.88 } })
    )
    expect(result).toMatchObject({ disposition: 'duplicate', launchNew: false })
    expect(result.reason).toContain('ask it where it stands')
    expect(result.recommend).toContain('omni session ask --pane dup:leaf --question')
  })

  it('is not a duplicate when either order is unsure or missing', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('dup:leaf', inFolder, { state: 'working' })]
      },
      deps({ 'dup:leaf': { related: 0.95, duplicate: null } })
    )
    expect(result.disposition).toBe('busy-related')
  })

  it('file-conflict owner idle: assign, even with JEV down, and names the files', async () => {
    const d = deps({}, {}, { 'repo::/auth': ['src/auth/login.ts', 'README.md'] })
    const result = await findSessionOwner(
      { task: FILE_TASK, scope: {}, observed: [session('auth:leaf', editing)] },
      d
    )
    expect(result).toMatchObject({
      disposition: 'assign',
      launchNew: false,
      taskFiles: ['src/auth/login.ts'],
      owner: {
        paneKey: 'auth:leaf',
        signals: ['file-conflict'],
        conflictFiles: ['src/auth/login.ts'],
        related: null
      }
    })
    expect(result.reason).toContain('editing files this task names: src/auth/login.ts')
    expect(d.changes).toHaveBeenCalledTimes(1)
  })

  it('file-conflict owner working: conflict-owner-busy, never a parallel editor', async () => {
    const result = await findSessionOwner(
      {
        task: 'Refactor the auth helpers',
        files: ['src/auth/*.ts'],
        scope: {},
        observed: [session('auth:leaf', editing, { state: 'working' })]
      },
      deps({ 'auth:leaf': 0.2 }, {}, { 'repo::/auth': ['src/auth/session.ts'] })
    )
    expect(result).toMatchObject({
      disposition: 'conflict-owner-busy',
      launchNew: false,
      owner: { paneKey: 'auth:leaf', conflictFiles: ['src/auth/session.ts'], light: false }
    })
    expect(result.recommend).toContain('omni session ask --pane auth:leaf')
  })

  it('keeps an excluded local session visible to file-conflict detection without judging it', async () => {
    const d = deps({}, {}, { 'repo::/auth': ['src/auth/login.ts'] })
    const result = await findSessionOwner(
      {
        task: FILE_TASK,
        scope: {},
        exclude: new Set(['auth:leaf']),
        conflictExclude: new Set(['auth:leaf']),
        observed: [session('auth:leaf', editing, { state: 'idle' })]
      },
      d
    )
    expect(result.disposition).toBe('conflict-owner-busy')
    expect(result.owner).toMatchObject({
      paneKey: 'auth:leaf',
      light: false,
      signals: ['file-conflict'],
      conflictFiles: ['src/auth/login.ts'],
      related: null
    })
    expect(d.judge).not.toHaveBeenCalled()
    expect(d.changes).toHaveBeenCalledWith([
      { row: expect.any(Object), entry: expect.objectContaining({ paneKey: 'auth:leaf' }) }
    ])
  })

  it('keeps excluded remote file overlap explicitly unknown', async () => {
    const remote = session('auth:leaf', editing, { hostId: 'ssh:box', verdict: 'unverifiable' })
    const result = await findSessionOwner(
      {
        task: FILE_TASK,
        scope: { repoId: 'repo' },
        exclude: new Set(['auth:leaf']),
        conflictExclude: new Set(['auth:leaf']),
        observed: [remote]
      },
      deps({})
    )
    expect(result.disposition).toBe('coverage-incomplete')
    expect(result.unchecked).toContainEqual(
      expect.objectContaining({
        paneKey: 'auth:leaf',
        risk: 'possible-file-conflict',
        reason:
          'excluded session file overlap is unknown because its execution host cannot be inspected'
      })
    )
  })

  it('does not treat an excluded asking pane as its own file-conflict owner by default', async () => {
    const asker = session('asker:leaf', { ...editing, repoId: 'repo-1' })
    const result = await findSessionOwner(
      {
        task: FILE_TASK,
        scope: { repoId: 'repo-1' },
        exclude: new Set(['asker:leaf']),
        observed: [asker]
      },
      deps({}, {}, { 'repo::/auth': ['src/auth/login.ts'] })
    )
    expect(result.disposition).toBe('launch-new')
    expect(result.unchecked).toEqual([])
  })

  it('ranks the file-conflict owner above a free, more related session', async () => {
    const result = await findSessionOwner(
      {
        task: FILE_TASK,
        scope: { folderId: 'folder-ads' },
        observed: [
          session('near:leaf', inFolder),
          session('auth:leaf', editing, { state: 'working' })
        ]
      },
      deps({ 'near:leaf': 0.99, 'auth:leaf': 0.1 }, {}, { 'repo::/auth': ['src/auth/login.ts'] })
    )
    expect(result.disposition).toBe('conflict-owner-busy')
    expect(result.candidates[0]!.paneKey).toBe('auth:leaf')
  })

  it('a busy session working in the target workspace blocks a parallel editor', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { targetWorktreeId: 'repo::/auth' },
        observed: [session('auth:leaf', editing, { state: 'working' })]
      },
      deps({ 'auth:leaf': 0.1 })
    )
    expect(result).toMatchObject({
      disposition: 'conflict-owner-busy',
      owner: { signals: ['target-worktree'] }
    })
  })

  const marketing = {
    worktreeId: 'folder::/Marketing',
    worktreePath: '/Marketing',
    workspaceKind: 'folder' as const
  }

  it('a session in a target folder workspace is a place, not a conflict: unrelated does not block', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { targetWorktreeId: 'folder::/Marketing' },
        observed: [session('mkt:leaf', marketing, { state: 'working' })]
      },
      deps({ 'mkt:leaf': 0.07 })
    )
    expect(result).toMatchObject({ disposition: 'launch-new', launchNew: true })
    expect(result.candidates[0]!.signals).toEqual(['same-worktree'])
  })

  it('an idle session in a target folder workspace gets the task only when JEV rates it related', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { targetWorktreeId: 'folder::/Marketing' },
        observed: [session('mkt:leaf', marketing)]
      },
      deps({ 'mkt:leaf': 0.93 })
    )
    expect(result).toMatchObject({
      disposition: 'assign',
      owner: { paneKey: 'mkt:leaf', signals: ['same-worktree'] }
    })
  })

  it('reads no git when the task names no files', async () => {
    const d = deps({ 'tab-1:leaf-1': 0.9 })
    await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-1:leaf-1', inFolder)]
      },
      d
    )
    expect(d.changes).not.toHaveBeenCalled()
  })

  it('coverage is incomplete when a session’s git status could not be read', async () => {
    const result = await findSessionOwner(
      { task: FILE_TASK, scope: {}, observed: [session('auth:leaf', editing)] },
      deps({}, {}, { 'repo::/auth': 'unreadable' })
    )
    expect(result.disposition).toBe('coverage-incomplete')
    expect(result.unchecked[0]!.reason).toContain('git status could not be read')
  })

  it('launch dispositions recommend omni session launch with the target worktree', async () => {
    const launch = (worktree = '') =>
      `omni session launch --provider <claude|codex> --prompt-file <brief.md>${worktree} --json`
    const target = { folderId: 'folder-ads', targetWorktreeId: 'repo::/w/ads-retry' }

    const busy = await findSessionOwner(
      {
        task: TASK,
        scope: target,
        observed: [session('tab-1:leaf-1', inFolder, { state: 'working' })]
      },
      deps({ 'tab-1:leaf-1': 0.95 })
    )
    expect(busy.disposition).toBe('busy-related')
    expect(busy.recommend).toBe(launch(' --worktree id:repo::/w/ads-retry'))

    const unrelated = await findSessionOwner(
      { task: TASK, scope: target, observed: [session('tab-1:leaf-1', inFolder)] },
      deps({ 'tab-1:leaf-1': 0.12 })
    )
    expect(unrelated.disposition).toBe('launch-new')
    expect(unrelated.recommend).toBe(launch(' --worktree id:repo::/w/ads-retry'))

    const unjudged = await findSessionOwner(
      { task: TASK, scope: target, observed: [session('tab-1:leaf-1', inFolder)] },
      deps({})
    )
    expect(unjudged.disposition).toBe('launch-new')
    expect(unjudged.recommend).toBe(launch(' --worktree id:repo::/w/ads-retry'))

    const unchecked = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads' },
        observed: [session('tab-4:leaf-1', { ...inFolder, hostUnavailable: true })]
      },
      deps({})
    )
    expect(unchecked.disposition).toBe('coverage-incomplete')
    expect(unchecked.recommend).toBe(launch())
  })

  it('quotes a target worktree id the shell would split', async () => {
    const result = await findSessionOwner(
      { task: TASK, scope: { targetWorktreeId: "repo::/Users/me/Sal's Work" }, observed: [] },
      deps({})
    )
    expect(result.disposition).toBe('launch-new')
    expect(result.recommend).toContain(`--worktree 'id:repo::/Users/me/Sal'\\''s Work' --json`)
  })

  it('recommends --project when the repository is a project other computers share', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { repoId: 'repo-1', projectId: 'github:omnirogue/omni-ide' },
        observed: []
      },
      deps({})
    )
    expect(result.disposition).toBe('launch-new')
    expect(result.recommend).toBe(
      'omni session launch --provider <claude|codex> --project github:omnirogue/omni-ide --prompt-file <brief.md> --json'
    )
  })

  it('keeps --worktree over --project: a named workspace already fixes the computer', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: {
          repoId: 'repo-1',
          projectId: 'github:omnirogue/omni-ide',
          targetWorktreeId: 'repo-1::/w/ads-retry'
        },
        observed: []
      },
      deps({})
    )
    expect(result.recommend).toBe(
      'omni session launch --provider <claude|codex> --prompt-file <brief.md> --worktree id:repo-1::/w/ads-retry --json'
    )
    expect(result.recommend).not.toContain('--project')
  })

  it('derives the project id only for identities another computer can share', () => {
    const repo = { id: 'repo-1', upstream: undefined, repoIcon: undefined }
    expect(
      sessionOwnerProjectId({
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.com/acme/tools',
          remoteName: 'origin',
          remoteUrl: 'https://gitlab.com/acme/tools.git'
        }
      })
    ).toBe('git:gitlab.com/acme/tools')
    expect(
      sessionOwnerProjectId({
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/omnirogue/omni-ide',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/omnirogue/omni-ide.git'
        }
      })
    ).toBe('github:omnirogue/omni-ide')
    // Why: a folder or remote-less repo falls back to `repo:<id>`, which no other computer has.
    expect(sessionOwnerProjectId({ ...repo, gitRemoteIdentity: null })).toBeNull()
    expect(sessionOwnerProjectId(undefined)).toBeNull()
  })

  it('keeps assign and ask recommendations for owners that can take the task', async () => {
    const result = await findSessionOwner(
      {
        task: TASK,
        scope: { folderId: 'folder-ads', targetWorktreeId: 'repo::/w/ads-retry' },
        observed: [session('tab-1:leaf-1', inFolder)]
      },
      deps({ 'tab-1:leaf-1': 0.93 })
    )
    expect(result.disposition).toBe('assign')
    expect(result.recommend).toContain('omni session assign --pane tab-1:leaf-1')
    expect(result.recommend).not.toContain('session launch')
  })
})

describe('sessionOwnerLoad', () => {
  it('is light only when idle with nothing queued, pending, waiting or driving it', () => {
    expect(sessionOwnerLoad(manageEntry(), false)).toEqual({
      light: true,
      words: 'idle, nothing queued or pending'
    })
    expect(sessionOwnerLoad(manageEntry({ queueLength: 1 }), false).light).toBe(false)
    expect(sessionOwnerLoad(manageEntry({ pendingSteps: ['Ship it'] }), false).light).toBe(false)
    expect(sessionOwnerLoad(manageEntry({ waitingOn: 'a question' }), false).light).toBe(false)
    expect(sessionOwnerLoad(manageEntry({ keepGoing: true }), false).words).toBe(
      'Keep going drives it'
    )
    expect(sessionOwnerLoad(manageEntry(), true).words).toBe(
      'an outcome run or session chain drives it'
    )
    expect(sessionOwnerLoad(manageEntry({ agentForeground: null }), false).light).toBe(false)
  })
})
