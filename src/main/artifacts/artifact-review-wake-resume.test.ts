import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { SessionManageRendererRequest } from '../../shared/session-manage-relay'
import * as transcripts from '../session-manage/session-transcript-locate'
import type { SourceReviewEntry } from './artifact-source-review-watch'
import { prepareReviewWake, type ReviewWakeDeps } from './artifact-review-wake'
import { runtimeReviewWakeDeps } from './artifact-review-wake-runtime'

const SESSION_ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const ACCOUNT = '/verified/account'
const TRANSCRIPT = `${ACCOUNT}/sessions/2026/10/07/rollout-${SESSION_ID}.jsonl`

describe('managed review resume confirmation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps the decision held without a second launch when the resumed Codex never reports its identity', async () => {
    vi.useFakeTimers()
    vi.spyOn(transcripts, 'locateTranscripts').mockResolvedValue([
      { path: TRANSCRIPT, providerRoot: ACCOUNT, defaultRoot: false }
    ])
    vi.spyOn(transcripts, 'readTranscriptCwd').mockResolvedValue('/workspace')
    const ensureAgentSession = vi.fn(async () => ({
      terminal: { handle: 'term_resumed', paneKey: 'tab_new:leaf_new', tabId: 'tab_new' },
      disposition: 'created'
    }))
    const reported = vi.fn(() => [])
    const runtime = {
      getStatus: () => ({ desktopWindowStatus: 'available' }),
      getAccountsSnapshot: () => ({ rateLimits: { accountCapacity: {} } }),
      requestSessionFolders: async (request: SessionManageRendererRequest) =>
        request.kind === 'conversationOrganization'
          ? { deleted: false, hidden: false, archiveKind: null }
          : [],
      ensureAgentSession,
      getReportedProviderSessionsForPane: reported
    } as unknown as Parameters<typeof runtimeReviewWakeDeps>[0]['runtime']
    const saved: ArtifactReviewSleep[] = []
    const deps: ReviewWakeDeps = {
      ...runtimeReviewWakeDeps({
        runtime,
        userDataPath: '/profile',
        profileId: 'profile',
        scope: {
          cloudUserId: 'user',
          cloudProfileId: 'profile',
          cloudOrganizationId: 'org',
          apiOrigin: 'https://example.test'
        },
        account: 'account'
      }),
      saveSleep: (_entry, sleep) => {
        saved.push(sleep)
        return true
      },
      audit: vi.fn(),
      wakeClaimElsewhere: async () => null,
      withdrawWakeCopy: async () => 'ok'
    }
    const entry: SourceReviewEntry = {
      sourceKey: '/workspace/result.md',
      slug: 'result',
      sourceReview: {
        ledgerId: 'als_0123456789abcdef01234567',
        nativeSessionId: SESSION_ID,
        paneKey: 'tab_old:leaf_old',
        worktreeId: 'workspace',
        account: 'account',
        revision: 1
      }
    }
    const sleep: ArtifactReviewSleep = {
      state: 'asleep',
      revision: 1,
      armedAt: 1,
      at: 1,
      provider: 'codex',
      accountHome: ACCOUNT,
      transcriptPath: TRANSCRIPT,
      model: 'gpt-6.1-sol',
      effort: 'high'
    }
    const pending = prepareReviewWake(deps, entry, sleep)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({
      kind: 'hold',
      reason: expect.stringContaining('unconfirmed')
    })
    expect(reported).toHaveBeenCalled()
    expect(ensureAgentSession).toHaveBeenCalledExactlyOnceWith(
      {
        kind: 'explicit',
        worktree: 'path:/workspace',
        agent: 'codex',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath: TRANSCRIPT },
        launchPreferences: { model: 'gpt-6.1-sol', effort: 'high' }
      },
      { launchCause: { trigger: 'hibernation-wake', actor: { kind: 'app' } } },
      undefined,
      { revealInSidebar: true }
    )
    expect(saved.map((value) => value.state)).toEqual(['waking', 'stalled'])
    const stalled = saved.at(-1)!
    expect(stalled.retryAfter).toBeUndefined()
    expect(entry.sourceReview.receipt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await prepareReviewWake(deps, entry, stalled)).toMatchObject({ kind: 'hold' })
    expect(ensureAgentSession).toHaveBeenCalledOnce()
  })
})
