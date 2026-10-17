import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewDecision } from '../../shared/artifact-review'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'
import {
  endReviewWaitWithoutDecision,
  handleReviewReject,
  type ReviewRejectDeps
} from './artifact-review-reject'
import type { SourceReviewEntry } from './artifact-source-review-watch'

const ENTRY: SourceReviewEntry = {
  sourceKey: '/work/plan.md',
  slug: 'plan',
  sourceReview: {
    ledgerId: 'als_0123456789abcdef01234567',
    nativeSessionId: 'conv-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo::/w',
    account: 'account',
    revision: 2
  }
}
const DECISION: ArtifactReviewDecision = {
  id: '9',
  revision: 2,
  decision: 'rejected',
  comment: 'no',
  edits: null,
  by: { email: 'uma@x.com', name: 'Uma' },
  at: '2026-10-05T18:03:00Z'
}
const SLEEP: ArtifactReviewSleep = {
  state: 'asleep',
  revision: 2,
  armedAt: 1,
  at: 1,
  provider: 'claude',
  transcriptPath: '/acc/projects/-w/conv-1.jsonl',
  workspace: {
    kind: 'git',
    path: '/w',
    branch: 'feat',
    createdForSession: true,
    worktreeId: 'repo::/w'
  }
}
const own = sidebarRow({ providerSessionId: 'conv-1' })

function harness(rows: SessionManageSidebarRow[], verdict: Partial<SessionManageEntry>) {
  const saved: ArtifactReviewSleep[] = []
  const deps: ReviewRejectDeps = {
    readWindowRows: vi.fn(async () => rows),
    observe: vi.fn(
      async (row) =>
        ({ title: row.title, verdict: 'exited', state: 'exited', ...verdict }) as SessionManageEntry
    ),
    windowAttached: () => true,
    paneParked: async () => false,
    conversationDeleted: vi.fn(async () => true),
    protection: vi.fn(async () => null),
    otherOpenReviews: vi.fn(async () => []),
    deleteRow: vi.fn(async () => 'closed' as const),
    purgeStores: vi.fn(async () => ['1 queued prompt']),
    purgeTranscripts: vi.fn(async () => ({ removed: ['/a.jsonl', '/a'], failed: [] })),
    purgeWorkspace: vi.fn(async () => ({
      removed: ['worktree /w', 'local branch feat'],
      kept: ['remote branch origin/feat: review #12 is open from it']
    })),
    saveSleep: vi.fn((_entry, sleep) => {
      saved.push(sleep)
      return true
    }),
    audit: vi.fn(async () => {}),
    now: () => 99
  }
  return { deps, saved }
}

describe('reject deletes the session that asked', () => {
  it('deletes a sleeping session for good and records exactly what went', async () => {
    const { deps, saved } = harness([own], {})
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(deps.deleteRow).toHaveBeenCalledWith(
      own,
      'Rejected on review page plan revision 2 by Uma',
      'artifact-review:plan:9'
    )
    expect(deps.purgeTranscripts).toHaveBeenCalledWith(
      'claude',
      'conv-1',
      '/acc/projects/-w/conv-1.jsonl'
    )
    expect(deps.purgeWorkspace).toHaveBeenCalledWith({
      worktreeId: 'repo::/w',
      workspace: SLEEP.workspace,
      sharedWithAnotherSession: false
    })
    const summary = vi.mocked(deps.audit).mock.calls[0]![2]
    expect(summary).toContain('not in Recently closed')
    expect(summary).toContain('review #12 is open from it')
    expect(saved.at(-1)).toMatchObject({ state: 'deleted', at: 99 })
  })

  it('tells a working session to stop and deletes it only once idle', async () => {
    const { deps } = harness([own], { verdict: 'live', state: 'working' })
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('deliver')
    expect(deps.deleteRow).not.toHaveBeenCalled()
  })

  it('never deletes what it cannot verify, nor without a window', async () => {
    const unverified = harness([own], { verdict: 'unverifiable', state: 'unknown' })
    expect(await handleReviewReject(unverified.deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(unverified.deps.deleteRow).not.toHaveBeenCalled()
    const windowless = harness([own], {})
    windowless.deps.windowAttached = () => false
    expect(await handleReviewReject(windowless.deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(windowless.deps.deleteRow).not.toHaveBeenCalled()
    expect(windowless.saved.at(-1)?.reason).toContain('when the OmniConsole window opens')
  })

  it('keeps a protected session and one that still waits on another page', async () => {
    const protectedSession = harness([own], {})
    protectedSession.deps.protection = vi.fn(async () => 'pinned')
    expect(await handleReviewReject(protectedSession.deps, ENTRY, SLEEP, DECISION)).toBe('deliver')
    expect(protectedSession.saved.at(-1)).toMatchObject({ state: 'stalled' })
    const other = harness([own], {})
    other.deps.otherOpenReviews = async () => ['other-page']
    expect(await handleReviewReject(other.deps, ENTRY, SLEEP, DECISION)).toBe('deliver')
    expect(other.deps.deleteRow).not.toHaveBeenCalled()
  })

  it('deletes a parked pane that has no terminal record after a restart', async () => {
    const parked = sidebarRow({ providerSessionId: 'conv-1', resumable: true })
    const { deps } = harness([parked], { verdict: 'unverifiable', state: 'unknown' })
    deps.paneParked = async () => true
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(deps.deleteRow).toHaveBeenCalled()
  })

  it('stops when a tab will not close, and keeps a worktree another session uses', async () => {
    const declined = harness([own], {})
    declined.deps.deleteRow = vi.fn(async () => 'declined' as const)
    expect(await handleReviewReject(declined.deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(declined.deps.purgeTranscripts).not.toHaveBeenCalled()
    const neighbour = sidebarRow({
      paneKey: 'tab-9:leaf-1',
      rowKey: 'row-9',
      providerSessionId: 'conv-9'
    })
    const shared = harness([own, neighbour], {})
    await handleReviewReject(shared.deps, ENTRY, SLEEP, DECISION)
    expect(vi.mocked(shared.deps.purgeWorkspace).mock.calls[0]![0].sharedWithAnotherSession).toBe(
      true
    )
  })

  it('checks and deletes a second (folded) pane of the same conversation', async () => {
    const second = sidebarRow({
      paneKey: 'tab-2:leaf-1',
      rowKey: 'row-2',
      providerSessionId: 'conv-1',
      folded: true
    })
    const busy = harness([own, second], {})
    busy.deps.observe = vi.fn(
      async (row) =>
        (row === second
          ? { title: 'second', verdict: 'live', state: 'waiting-for-yes' }
          : { title: 'own', verdict: 'exited', state: 'exited' }) as unknown as SessionManageEntry
    )
    expect(await handleReviewReject(busy.deps, ENTRY, SLEEP, DECISION)).toBe('deliver')
    expect(busy.deps.deleteRow).not.toHaveBeenCalled()
    const idle = harness([own, second], {})
    await handleReviewReject(idle.deps, ENTRY, SLEEP, DECISION)
    expect(idle.deps.deleteRow).toHaveBeenCalledTimes(2)
  })

  it('purges nothing when the window cannot list its rows', async () => {
    const { deps } = harness([own], {})
    deps.readWindowRows = vi.fn(async () => {
      throw new Error('No window')
    })
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(deps.purgeTranscripts).not.toHaveBeenCalled()
    expect(deps.purgeWorkspace).not.toHaveBeenCalled()
  })

  it('finishes a delete a crash interrupted, without re-checking what is already gone', async () => {
    const { deps, saved } = harness([], {})
    deps.protection = vi.fn(async () => 'protection-unknown')
    const interrupted = { ...SLEEP, purge: { decisionId: '9', at: 1 } }
    expect(await handleReviewReject(deps, ENTRY, interrupted, DECISION)).toBe('done')
    expect(deps.protection).not.toHaveBeenCalled()
    expect(deps.purgeTranscripts).toHaveBeenCalled()
    expect(saved.at(-1)).toMatchObject({ state: 'deleted' })
    expect(saved.at(-1)).not.toHaveProperty('purge')
  })

  it('marks the delete begun before the first tab closes', async () => {
    const { deps, saved } = harness([own], {})
    deps.deleteRow = vi.fn(async () => {
      expect(saved.at(-1)).toMatchObject({ purge: { decisionId: '9' } })
      return 'closed' as const
    })
    await handleReviewReject(deps, ENTRY, SLEEP, DECISION)
    expect(deps.deleteRow).toHaveBeenCalledOnce()
  })

  it('never adds its old pane when that pane now holds another conversation', async () => {
    const reused = sidebarRow({ providerSessionId: 'someone-else' })
    const { deps } = harness([reused], {})
    await handleReviewReject(deps, ENTRY, SLEEP, DECISION)
    expect(deps.deleteRow).not.toHaveBeenCalled()
  })

  it('purges nothing while the window lists no pane for it (still loading, or closed)', async () => {
    const { deps } = harness([], {})
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(deps.purgeTranscripts).not.toHaveBeenCalled()
    expect(deps.purgeWorkspace).not.toHaveBeenCalled()
  })

  it('retries a close that failed after another tab closed, keeping the delete begun', async () => {
    const second = sidebarRow({
      paneKey: 'tab-2:leaf-1',
      rowKey: 'row-2',
      providerSessionId: 'conv-1'
    })
    const { deps, saved } = harness([own, second], {})
    let calls = 0
    deps.deleteRow = vi.fn(async () => {
      calls += 1
      if (calls === 2) {
        throw new Error('relay closed')
      }
      return 'closed' as const
    })
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('done')
    expect(deps.purgeTranscripts).not.toHaveBeenCalled()
    expect(saved.at(-1)).toMatchObject({ purge: { decisionId: '9', began: true } })
    expect(saved.at(-1)?.state).not.toBe('stalled')
  })

  it('checks everything again after the window refused the first tab (it turned busy)', async () => {
    const { deps, saved } = harness([own], {})
    deps.deleteRow = vi.fn(async () => {
      throw new Error('“Plan” is still working.')
    })
    expect(await handleReviewReject(deps, ENTRY, SLEEP, DECISION)).toBe('done')
    const sent = saved.at(-1)!
    expect(sent.purge).toEqual({ decisionId: '9', at: 99 })
    // The next pass finds it pinned since: kept, the marker dropped, nothing purged.
    const next = harness([own], {})
    next.deps.protection = vi.fn(async () => 'pinned')
    expect(await handleReviewReject(next.deps, ENTRY, sent, DECISION)).toBe('deliver')
    expect(next.deps.deleteRow).not.toHaveBeenCalled()
    expect(next.deps.purgeTranscripts).not.toHaveBeenCalled()
    expect(next.saved.at(-1)).toMatchObject({ state: 'stalled' })
    expect(next.saved.at(-1)).not.toHaveProperty('purge')
  })

  it('never finishes a refused delete just because a person closed the tab since', async () => {
    const { deps } = harness([], {})
    deps.conversationDeleted = vi.fn(async () => false)
    const sent = { ...SLEEP, purge: { decisionId: '9', at: 1 } }
    expect(await handleReviewReject(deps, ENTRY, sent, DECISION)).toBe('done')
    expect(deps.conversationDeleted).toHaveBeenCalledWith('conv-1')
    expect(deps.purgeTranscripts).not.toHaveBeenCalled()
    expect(deps.purgeWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the marker while it waits for a window to finish a begun delete', async () => {
    const { deps, saved } = harness([own], {})
    deps.windowAttached = () => false
    const begun = { ...SLEEP, purge: { decisionId: '9', at: 1, began: true as const } }
    expect(await handleReviewReject(deps, ENTRY, begun, DECISION)).toBe('done')
    expect(saved.at(-1)).toMatchObject({ purge: begun.purge })
  })

  it('deletes nothing here for a session that moved to another computer', async () => {
    const { deps } = harness([own], {})
    expect(await handleReviewReject(deps, ENTRY, { ...SLEEP, state: 'moved' }, DECISION)).toBe(
      'done'
    )
    expect(deps.deleteRow).not.toHaveBeenCalled()
    expect(deps.purgeTranscripts).not.toHaveBeenCalled()
  })

  it('leaves sessions with no wait to the normal notice, and ignores a deleted one', async () => {
    const { deps } = harness([own], {})
    expect(await handleReviewReject(deps, ENTRY, undefined, DECISION)).toBe('deliver')
    expect(await handleReviewReject(deps, ENTRY, { ...SLEEP, state: 'deleted' }, DECISION)).toBe(
      'done'
    )
    expect(deps.deleteRow).not.toHaveBeenCalled()
  })
})

describe('a page closed without a decision', () => {
  function closeDeps(verdict: 'live' | 'exited', protection: string | null = null) {
    return {
      readWindowRows: async () => [own],
      observe: async () => ({ verdict, state: verdict }) as unknown as SessionManageEntry,
      windowAttached: () => true,
      protection: async () => protection,
      otherOpenReviews: async () => [],
      archiveRow: vi.fn(async () => {}),
      clearSleep: vi.fn()
    }
  }

  it('archives a sleeping session (undoable) and ends its wait', async () => {
    const deps = closeDeps('exited')
    await endReviewWaitWithoutDecision(deps, ENTRY, SLEEP)
    expect(deps.archiveRow).toHaveBeenCalledWith(
      own,
      'Its review page plan was closed without a decision'
    )
    expect(deps.clearSleep).toHaveBeenCalledOnce()
  })

  it('only ends the wait of a live, protected or still-waiting one', async () => {
    for (const deps of [closeDeps('live'), closeDeps('exited', 'pinned')]) {
      await endReviewWaitWithoutDecision(deps, ENTRY, SLEEP)
      expect(deps.archiveRow).not.toHaveBeenCalled()
      expect(deps.clearSleep).toHaveBeenCalledOnce()
    }
    const live = closeDeps('exited')
    await endReviewWaitWithoutDecision(live, ENTRY, { ...SLEEP, state: 'waiting' })
    expect(live.archiveRow).not.toHaveBeenCalled()
  })

  it('keeps the wait while no window can answer', async () => {
    const deps = { ...closeDeps('exited'), windowAttached: () => false }
    await endReviewWaitWithoutDecision(deps, ENTRY, SLEEP)
    expect(deps.clearSleep).not.toHaveBeenCalled()
  })
})
