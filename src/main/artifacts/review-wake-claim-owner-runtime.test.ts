import { describe, expect, it, vi } from 'vitest'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import { conversationRunning, runtimePaneParked } from './review-wake-claim-owner-runtime'

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

function runtime(input: { handle?: string | null; reportedAt?: number; parked?: boolean }) {
  return {
    getTerminalHandleForPaneKey: () => input.handle ?? null,
    getLastAgentHookRowForPane: () =>
      input.reportedAt === undefined ? null : ({ receivedAt: input.reportedAt } as never),
    requestSessionFolders: vi.fn(async () => input.parked ?? false)
  }
}

describe('a pane parked by sleep', () => {
  it('asks the window when there is one', async () => {
    const parked = runtimePaneParked(
      runtime({ parked: true }),
      () => true,
      () => 1e9
    )
    expect(await parked('tab-1:leaf-1', 100)).toBe(true)
    expect(await runtimePaneParked(runtime({ handle: 'h' }), () => true)('p', 100)).toBe(false)
  })

  it('without a window, needs time to adopt the daemon’s terminals and no report since it slept', async () => {
    const noWindow = () => false
    expect(await runtimePaneParked(runtime({}), noWindow, () => 1e9)('p', 100)).toBe(true)
    expect(await runtimePaneParked(runtime({}), noWindow, () => 30_000)('p', 100)).toBe(false)
    expect(
      await runtimePaneParked(runtime({ reportedAt: 100 + 61_000 }), noWindow, () => 1e9)('p', 100)
    ).toBe(false)
    // A late exit report just after the sleep is no resume.
    expect(
      await runtimePaneParked(runtime({ reportedAt: 100 + 5_000 }), noWindow, () => 1e9)('p', 100)
    ).toBe(true)
    expect(await runtimePaneParked(runtime({}), noWindow, () => 1e9)('p', undefined)).toBe(false)
  })
})

describe('whether the conversation runs here', () => {
  const own = sidebarRow({ providerSessionId: 'conv-1' })
  const run = (verdict: string, parked: boolean) =>
    conversationRunning({
      readRows: async () => [own],
      observe: async () => ({ verdict }) as never,
      paneParked: async () => parked
    })(ENTRY, 100)

  it('is true for a live holder, false for exited or parked ones, null when it cannot tell', async () => {
    expect(await run('live', false)).toBe(true)
    expect(await run('exited', false)).toBe(false)
    expect(await run('unverifiable', true)).toBe(false)
    expect(await run('unverifiable', false)).toBeNull()
  })
})

describe('withdrawing a copy', () => {
  it('counts only a done delete or a page that is gone as withdrawn', async () => {
    const { withdrawWakeCopy } = await import('./review-wake-copy-api')
    const answer = (result: unknown) => withdrawWakeCopy(vi.fn(async () => result) as never, 'plan')
    expect(await answer({ status: 'ok', value: {} })).toBe('ok')
    expect(await answer({ status: 'refused', code: 'artifact_not_found' })).toBe('ok')
    expect(await answer({ status: 'refused', code: 'wake_claimed' })).toBe('claimed')
    expect(await answer({ status: 'refused', code: 'rate_limited' })).toBe('failed')
    expect(await answer({ status: 'failed' })).toBe('failed')
  })
})
