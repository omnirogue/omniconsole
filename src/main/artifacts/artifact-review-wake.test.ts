import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import { markReviewDelivered, prepareReviewWake, type ReviewWakeDeps } from './artifact-review-wake'

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

function sleep(state: ArtifactReviewSleep['state']): ArtifactReviewSleep {
  return {
    state,
    revision: 2,
    armedAt: 1,
    at: 1,
    provider: 'claude',
    accountHome: '/acc',
    model: 'opus',
    effort: 'xhigh'
  }
}

type Verdict = Pick<SessionManageEntry, 'verdict' | 'state'>

function harness(rows: SessionManageSidebarRow[], verdicts: Record<string, Verdict>) {
  const saved: ArtifactReviewSleep[] = []
  const deps: ReviewWakeDeps = {
    readRows: vi.fn(async () => rows),
    observe: vi.fn(
      async (row) =>
        ({ title: row.title, ...verdicts[row.paneKey!] }) as unknown as SessionManageEntry
    ),
    wakeBlocked: vi.fn(() => null),
    capacity: vi.fn(async () => ({ ok: true as const })),
    resume: vi.fn(async () => ({ summary: 'resumed' }) as never),
    startedTerminal: vi.fn(
      (error) => error instanceof Error && error.message.startsWith('started')
    ),
    restartParked: vi.fn(async () => ({ summary: 'restarted from its checkpoint' })),
    paneHasTerminal: vi.fn(() => true),
    ledgerFor: vi.fn((paneKey) => ({ ledgerId: `als_${paneKey}`, nativeSessionId: 'conv-1' })),
    saveSleep: vi.fn((_entry, next) => {
      saved.push(next)
      return true
    }),
    rebind: vi.fn((entry, next) => ({ ...entry.sourceReview, ...next })),
    audit: vi.fn(),
    wakeClaimElsewhere: vi.fn(async () => null),
    withdrawWakeCopy: vi.fn(async () => 'ok' as const),
    now: () => 50
  }
  return { deps, saved }
}

const own = sidebarRow({ providerSessionId: 'conv-1' })

describe('review wake', () => {
  it('leaves a session with no wait, or an old revision, to the normal delivery', async () => {
    const { deps } = harness([own], {})
    expect(await prepareReviewWake(deps, ENTRY, undefined)).toEqual({
      kind: 'deliver',
      entry: ENTRY,
      woke: false
    })
    expect(await prepareReviewWake(deps, ENTRY, { ...sleep('asleep'), revision: 1 })).toEqual({
      kind: 'deliver',
      entry: ENTRY,
      woke: false
    })
    expect(deps.readRows).not.toHaveBeenCalled()
  })

  it('delivers to a session still live in its Waiting window', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'live', state: 'idle' } })
    expect(await prepareReviewWake(deps, ENTRY, sleep('waiting'))).toEqual({
      kind: 'deliver',
      entry: ENTRY,
      woke: false
    })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('never wakes a session another computer took, nor one that moved', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    deps.wakeClaimElsewhere = vi.fn(async () => 'it is waking on Mac Studio')
    expect(await prepareReviewWake(deps, ENTRY, sleep('asleep'))).toEqual({
      kind: 'hold',
      reason: 'it is waking on Mac Studio'
    })
    expect(
      await prepareReviewWake(deps, ENTRY, { ...sleep('moved'), reason: 'Moved to Mac Studio' })
    ).toEqual({ kind: 'hold', reason: 'Moved to Mac Studio' })
    expect(deps.resume).not.toHaveBeenCalled()
    expect(deps.readRows).not.toHaveBeenCalled()
  })

  it('withdraws its copy before waking it here, and holds when another computer took it', async () => {
    const withCopy = {
      ...sleep('asleep'),
      wakeCopy: { revision: 2, at: 1, sha256: 'a'.repeat(64) }
    }
    const claimed = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    claimed.deps.withdrawWakeCopy = vi.fn(async () => 'claimed' as const)
    expect(await prepareReviewWake(claimed.deps, ENTRY, withCopy)).toEqual({
      kind: 'hold',
      reason: 'another computer took it first'
    })
    expect(claimed.deps.resume).not.toHaveBeenCalled()
    const failed = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    failed.deps.withdrawWakeCopy = vi.fn(async () => 'failed' as const)
    expect((await prepareReviewWake(failed.deps, ENTRY, withCopy)).kind).toBe('hold')
    expect(failed.deps.resume).not.toHaveBeenCalled()
    const ok = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    await prepareReviewWake(ok.deps, ENTRY, withCopy)
    expect(ok.deps.withdrawWakeCopy).toHaveBeenCalledWith(ENTRY)
    expect(ok.deps.resume).toHaveBeenCalled()
    expect(ok.saved[0]).toMatchObject({ state: 'waking' })
    expect(ok.saved[0]).not.toHaveProperty('wakeCopy')
  })

  it('never wakes a conversation it cannot verify', async () => {
    const { deps } = harness([own], {
      'tab-1:leaf-1': { verdict: 'unverifiable', state: 'unknown' }
    })
    const outcome = await prepareReviewWake(deps, ENTRY, sleep('asleep'))
    expect(outcome.kind).toBe('hold')
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('holds the wake while its own account has no capacity, and never resumes', async () => {
    const { deps, saved } = harness([own], {
      'tab-1:leaf-1': { verdict: 'exited', state: 'exited' }
    })
    deps.capacity = vi.fn(async () => ({
      ok: false as const,
      reason: 'capacity: waiting for a@b.c (resets ~16:40 ET)',
      retryAfter: 99
    }))
    expect((await prepareReviewWake(deps, ENTRY, sleep('asleep'))).kind).toBe('hold')
    expect(deps.resume).not.toHaveBeenCalled()
    expect(saved.at(-1)).toMatchObject({ state: 'asleep', retryAfter: 99 })
  })

  it('resumes the same conversation once and rebinds to the pane it now runs in', async () => {
    const woken = sidebarRow({
      paneKey: 'tab-2:leaf-1',
      tabId: 'tab-2',
      rowKey: 'row-2',
      providerSessionId: 'conv-1'
    })
    const rows = [own]
    const { deps, saved } = harness(rows, {
      'tab-1:leaf-1': { verdict: 'exited', state: 'exited' },
      'tab-2:leaf-1': { verdict: 'live', state: 'idle' }
    })
    deps.resume = vi.fn(async () => {
      rows.push(woken)
      return { summary: 'resumed' } as never
    })
    const outcome = await prepareReviewWake(deps, ENTRY, sleep('asleep'))
    expect(deps.resume).toHaveBeenCalledWith('claude:conv-1@local', expect.anything())
    expect(saved[0]).toMatchObject({ state: 'waking' })
    // No copy was up, so there was nothing to withdraw.
    expect(deps.withdrawWakeCopy).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      kind: 'deliver',
      woke: true,
      entry: {
        ...ENTRY,
        sourceReview: {
          ...ENTRY.sourceReview,
          paneKey: 'tab-2:leaf-1',
          ledgerId: 'als_tab-2:leaf-1'
        }
      }
    })
  })

  it('records a stalled wake with its reason and retries later', async () => {
    const { deps, saved } = harness([own], {
      'tab-1:leaf-1': { verdict: 'exited', state: 'exited' }
    })
    deps.resume = vi.fn(async () => {
      throw new Error('No transcript was found')
    })
    expect((await prepareReviewWake(deps, ENTRY, sleep('asleep'))).kind).toBe('hold')
    expect(saved.at(-1)).toMatchObject({ state: 'stalled', reason: 'No transcript was found' })
    expect(saved.at(-1)?.retryAfter).toBe(50 + 5 * 60_000)
    expect(deps.audit).toHaveBeenCalled()
  })

  it('finds a pane a previous pass woke instead of starting another copy', async () => {
    const woken = sidebarRow({
      paneKey: 'tab-2:leaf-1',
      rowKey: 'row-2',
      providerSessionId: 'conv-1'
    })
    const { deps } = harness([own, woken], {
      'tab-1:leaf-1': { verdict: 'exited', state: 'exited' },
      'tab-2:leaf-1': { verdict: 'live', state: 'working' }
    })
    const outcome = await prepareReviewWake(deps, ENTRY, sleep('waking'))
    expect(outcome.kind).toBe('deliver')
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('does not resume again while an earlier wake may still be starting', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    const starting = { ...sleep('waking'), at: 40 }
    expect((await prepareReviewWake(deps, ENTRY, starting)).kind).toBe('hold')
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('delivers to its own live pane even when its state reads unknown', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'live', state: 'unknown' } })
    expect((await prepareReviewWake(deps, ENTRY, sleep('asleep'))).kind).toBe('deliver')
  })

  it('never resumes a session that was not put to sleep for this review', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    expect((await prepareReviewWake(deps, ENTRY, sleep('waiting'))).kind).toBe('hold')
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('waits for a window instead of resuming without one', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'exited', state: 'exited' } })
    deps.wakeBlocked = () => 'it wakes when the OmniConsole window opens on this computer'
    expect(await prepareReviewWake(deps, ENTRY, sleep('asleep'))).toEqual({
      kind: 'hold',
      reason: 'it wakes when the OmniConsole window opens on this computer'
    })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('never retries by itself a resume that already started a terminal', async () => {
    const { deps, saved } = harness([own], {
      'tab-1:leaf-1': { verdict: 'exited', state: 'exited' }
    })
    deps.resume = vi.fn(async () => {
      throw new Error('started a terminal but it did not report')
    })
    await prepareReviewWake(deps, ENTRY, sleep('asleep'))
    const stalled = saved.at(-1)!
    expect(stalled).toMatchObject({ state: 'stalled' })
    expect(stalled.retryAfter).toBeUndefined()
    vi.mocked(deps.resume).mockClear()
    expect((await prepareReviewWake(deps, ENTRY, stalled)).kind).toBe('hold')
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('restarts a parked pane from its checkpoint when the runtime has no terminal for it', async () => {
    const parked = sidebarRow({ providerSessionId: 'conv-1', resumable: true })
    const { deps } = harness([parked], {
      'tab-1:leaf-1': { verdict: 'unverifiable', state: 'unknown' }
    })
    deps.paneHasTerminal = vi.fn(() => false)
    await prepareReviewWake(deps, ENTRY, sleep('asleep'))
    expect(deps.restartParked).toHaveBeenCalledWith(parked)
    expect(deps.resume).not.toHaveBeenCalled()
    vi.mocked(deps.restartParked).mockClear()
    deps.paneHasTerminal = vi.fn(() => true)
    expect((await prepareReviewWake(deps, ENTRY, sleep('asleep'))).kind).toBe('hold')
    expect(deps.restartParked).not.toHaveBeenCalled()
  })

  it('delivers to a live woken pane even when the old row cannot be verified', async () => {
    const woken = sidebarRow({
      paneKey: 'tab-2:leaf-1',
      rowKey: 'row-2',
      providerSessionId: 'conv-1'
    })
    const { deps } = harness([own, woken], {
      'tab-1:leaf-1': { verdict: 'unverifiable', state: 'unknown' },
      'tab-2:leaf-1': { verdict: 'live', state: 'idle' }
    })
    const outcome = await prepareReviewWake(deps, ENTRY, sleep('waking'))
    expect(outcome).toMatchObject({ kind: 'deliver', woke: true })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('does not claim it woke a session a person opened again', async () => {
    const { deps } = harness([own], { 'tab-1:leaf-1': { verdict: 'live', state: 'idle' } })
    expect(await prepareReviewWake(deps, ENTRY, sleep('asleep'))).toMatchObject({ woke: false })
  })

  it('marks the wait answered once the decision is queued', () => {
    const { deps, saved } = harness([], {})
    markReviewDelivered(deps, ENTRY, sleep('waking'))
    expect(saved.at(-1)).toMatchObject({ state: 'awake', at: 50 })
    markReviewDelivered(deps, ENTRY, { ...sleep('awake') })
    expect(saved).toHaveLength(1)
  })
})
