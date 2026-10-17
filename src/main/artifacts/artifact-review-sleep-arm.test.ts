import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

const saved: unknown[] = []
const record = {
  slug: 'plan',
  sourceReview: {
    ledgerId: 'als_0123456789abcdef01234567',
    nativeSessionId: 'conv-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo::/w',
    account: 'acct',
    revision: 3
  }
}
let hold: string | null = null

vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: () => '/ud' }))
vi.mock('./artifact-share-scope', () => ({
  activeArtifactShareScope: () => ({ profileId: 'p', scope: { cloudUserId: 'u' } })
}))
vi.mock('./artifact-share-record-store', () => ({ getArtifactShareRecord: () => record }))
vi.mock('./artifact-share-record-sleep', () => ({
  saveArtifactReviewSleep: (...args: unknown[]) => {
    saved.push(args[5])
    return true
  }
}))
vi.mock('../runtime/automatic-worker-cleanup-hold', () => ({
  readAutomaticWorkerCleanupHold: async () => hold
}))
vi.mock('../runtime/prompt-queue-agent-presence', () => ({
  readPaneAgentPresence: async () => ({ kind: 'proven', proof: { pid: 42 } })
}))
vi.mock('../pty/posix-pty-foreground-group', () => ({
  readPosixReceiverRow: async () => ({ command: 'claude --model opus --effort xhigh do it' })
}))

const { armArtifactReviewSleep, withArtifactSessionSleep } =
  await import('./artifact-review-sleep-arm')

function runtime(settings: Record<string, unknown> = {}, agentType = 'claude') {
  return {
    getLastAgentHookRowForPane: () => ({
      agentType,
      providerSession: {
        id: 'conv-1',
        transcriptPath: '/Users/me/.claude-accounts/a/projects/-w/conv-1.jsonl'
      }
    }),
    resolveTerminalPane: () => ({ executionHostId: 'local' }),
    getArtifactApiOrigin: () => 'https://omnios.example',
    describeReviewSleepWorkspace: async () => ({ kind: 'git', path: '/w', branch: 'feat' }),
    getHeadlessSleepSettings: () => ({
      idleAutoCloseMode: 'on',
      restoreFloodGuard: true,
      automaticSessionCleanupProtection: {
        protectedWorkspacePaths: [],
        protectedPaneKeys: [],
        protectStartedToday: true,
        timeZone: 'America/New_York'
      },
      reviewWaitLiveMinutes: 90,
      ...settings
    })
  } as unknown as OrcaRuntimeService
}

describe('arming the review sleep', () => {
  beforeEach(() => {
    saved.length = 0
    hold = null
  })

  it('records the wait with the account, model and effort, and tells the agent', async () => {
    const notice = await armArtifactReviewSleep(runtime(), { sourceKey: '/w/plan.md' }, 1_000)
    expect(notice).toEqual({ state: 'armed', liveMinutes: 90 })
    expect(saved[0]).toMatchObject({
      state: 'waiting',
      revision: 3,
      armedAt: 1_000,
      provider: 'claude',
      accountHome: '/Users/me/.claude-accounts/a',
      model: 'opus',
      effort: 'xhigh',
      workspace: { kind: 'git', path: '/w', branch: 'feat' }
    })
  })

  it('keeps the session running with --keep-session and removes any wait', async () => {
    expect(
      await armArtifactReviewSleep(runtime(), { sourceKey: '/w/plan.md', keepSession: true })
    ).toEqual({ state: 'kept' })
    expect(saved).toEqual([null])
  })

  it('says honestly when this computer will not sleep it', async () => {
    expect(
      await armArtifactReviewSleep(runtime({ idleAutoCloseMode: 'shadow' }), { sourceKey: '/x' })
    ).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Idle auto-close') })
    expect(
      await armArtifactReviewSleep(runtime({ automaticSessionCleanupProtection: null }), {
        sourceKey: '/x'
      })
    ).toMatchObject({ reason: expect.stringContaining('cleanup protections') })
    hold = 'pinned'
    expect(await armArtifactReviewSleep(runtime(), { sourceKey: '/x' })).toMatchObject({
      reason: expect.stringContaining('protected (pinned)')
    })
    expect(await armArtifactReviewSleep(runtime({}, 'gemini'), { sourceKey: '/x' })).toEqual({
      state: 'unavailable',
      reason: 'only Claude and Codex sessions sleep on a review'
    })
    // A refused wait leaves no record, so nothing sleeps, wakes or is deleted by a Reject.
    expect(saved).toEqual([null, null, null, null])
  })

  it('adds the notice only to a successful publish from a pane', async () => {
    const ok = { status: 'ok', value: { shareUrl: 'u' } }
    expect(await withArtifactSessionSleep(runtime(), { sourceKey: '/x' }, ok)).toBe(ok)
    expect(
      await withArtifactSessionSleep(
        runtime(),
        { sourceKey: '/x', origin: { paneKey: 'tab-1:leaf-1' } },
        ok
      )
    ).toEqual({
      status: 'ok',
      value: { shareUrl: 'u', sessionSleep: { state: 'armed', liveMinutes: 90 } }
    })
    const failed = { status: 'reconnect-required' }
    expect(await withArtifactSessionSleep(runtime(), { sourceKey: '/x', review: {} }, failed)).toBe(
      failed
    )
  })
})
