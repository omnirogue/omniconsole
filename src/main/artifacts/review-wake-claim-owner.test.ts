import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import { wakeClaimElsewhere, type WakeClaimOwnerDeps } from './review-wake-claim-owner'
import type { WakeClaim } from './review-wake-copy-api'

const ENTRY: SourceReviewEntry = {
  sourceKey: '/w/plan.md',
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
const SLEEP: ArtifactReviewSleep = {
  state: 'asleep',
  revision: 2,
  armedAt: 1,
  at: 1,
  provider: 'claude',
  wakeCopy: { revision: 2, at: 1, sha256: 'a'.repeat(64) }
}
const CLAIM: WakeClaim = {
  host: 'Mac Studio',
  hostId: 'host_studio',
  at: '2026-10-05T18:00:00Z',
  decisionId: '9',
  revision: 2,
  done: true
}

function harness(claim: WakeClaim | null | 'failed' | 'unsupported') {
  const saved: ArtifactReviewSleep[] = []
  const deps: WakeClaimOwnerDeps = {
    readClaim: vi.fn(async () =>
      claim === 'failed' || claim === 'unsupported'
        ? ({ status: claim } as const)
        : ({ status: 'ok', value: claim } as const)
    ),
    hostId: () => 'host_macbook',
    windowAttached: () => true,
    yieldConversation: vi.fn(async () => ({ status: 'ok' as const })),
    running: vi.fn(async () => false as boolean | null),
    forgetSleptPane: vi.fn(async () => true),
    archiveOwnRow: vi.fn(async () => {}),
    saveSleep: vi.fn((_entry, sleep) => {
      saved.push(sleep)
      return true
    }),
    now: () => 99
  }
  return { deps, saved }
}

describe('the computer a session slept on, before it wakes it', () => {
  it('wakes it when nobody else claimed it, or it claimed it itself', async () => {
    expect(await wakeClaimElsewhere(harness(null).deps, ENTRY, SLEEP)).toBeNull()
    expect(
      await wakeClaimElsewhere(harness({ ...CLAIM, hostId: 'host_macbook' }).deps, ENTRY, SLEEP)
    ).toBeNull()
    const { wakeCopy: _none, ...withoutCopy } = SLEEP
    expect(await wakeClaimElsewhere(harness('unsupported').deps, ENTRY, withoutCopy)).toBeNull()
    // An OmniOS without the route can only hold a copy this computer saw confirmed.
    expect(
      await wakeClaimElsewhere(harness('unsupported').deps, ENTRY, {
        ...SLEEP,
        wakeCopy: { revision: 2, at: 1, pending: true }
      })
    ).toBeNull()
  })

  it('holds while another computer wakes it, and when it cannot tell with a copy up', async () => {
    expect(await wakeClaimElsewhere(harness({ ...CLAIM, done: false }).deps, ENTRY, SLEEP)).toBe(
      'it is waking on Mac Studio'
    )
    expect(await wakeClaimElsewhere(harness('failed').deps, ENTRY, SLEEP)).toMatch(/could not say/)
    expect(await wakeClaimElsewhere(harness('unsupported').deps, ENTRY, SLEEP)).toMatch(
      /could not say/
    )
    expect(
      await wakeClaimElsewhere(harness('failed').deps, ENTRY, {
        ...SLEEP,
        wakeCopy: { revision: 2, at: 1, pending: true }
      })
    ).toMatch(/could not say/)
    const { wakeCopy: _copy, ...noCopy } = SLEEP
    expect(await wakeClaimElsewhere(harness('failed').deps, ENTRY, noCopy)).toBeNull()
  })

  it('gives a moved session up for good: registry, checkpoint, row and record', async () => {
    const { deps, saved } = harness(CLAIM)
    expect(await wakeClaimElsewhere(deps, ENTRY, SLEEP)).toBe('Moved to Mac Studio')
    expect(deps.yieldConversation).toHaveBeenCalledWith(SLEEP, 'conv-1', CLAIM)
    expect(deps.forgetSleptPane).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(deps.archiveOwnRow).toHaveBeenCalledWith(
      ENTRY,
      'Moved to Mac Studio; its history stays here'
    )
    expect(saved.at(-1)).toMatchObject({
      state: 'moved',
      reason: 'Moved to Mac Studio',
      movedTo: { host: 'Mac Studio' }
    })
    expect(deps.readClaim).toHaveBeenCalledWith('plan', 2)
  })

  it('never stops a copy a person opened here again, and says so', async () => {
    const { deps, saved } = harness(CLAIM)
    deps.running = vi.fn(async () => true)
    expect(await wakeClaimElsewhere(deps, ENTRY, SLEEP)).toMatch(/opened here again/)
    expect(deps.forgetSleptPane).not.toHaveBeenCalled()
    // Not given up while it runs here, and not saved again on the next pass.
    expect(deps.yieldConversation).not.toHaveBeenCalled()
    expect(saved.at(-1)).toMatchObject({ state: 'stalled' })
    await wakeClaimElsewhere(deps, ENTRY, saved.at(-1)!)
    expect(saved).toHaveLength(1)
  })

  it('tries the archive again on the next pass instead of calling it moved', async () => {
    const { deps, saved } = harness(CLAIM)
    deps.archiveOwnRow = vi.fn(async () => {
      throw new Error('relay closed')
    })
    expect(await wakeClaimElsewhere(deps, ENTRY, SLEEP)).toBe('Moved to Mac Studio')
    expect(saved).toEqual([])
  })

  it('finishes the move only once a window can drop the checkpoint', async () => {
    const { deps, saved } = harness(CLAIM)
    deps.windowAttached = () => false
    expect(await wakeClaimElsewhere(deps, ENTRY, SLEEP)).toBe('Moved to Mac Studio')
    expect(deps.yieldConversation).toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('never gives it up while it cannot tell whether anything runs it here', async () => {
    const { deps, saved } = harness(CLAIM)
    deps.running = vi.fn(async () => null)
    expect(await wakeClaimElsewhere(deps, ENTRY, SLEEP)).toMatch(/once nothing can be running it/)
    expect(deps.yieldConversation).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })
})
