import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type * as ProfilePaths from '../omni-profiles/profile-storage-paths'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { WorkerTerminalResourceRow } from '../runtime/orchestration/worker-terminal-ownership'
import {
  getArtifactShareRecord,
  saveArtifactShareRecord,
  type ArtifactShareRecord
} from './artifact-share-record-store'
import { saveArtifactReviewSleep } from './artifact-share-record-sleep'
import * as sleepStore from './artifact-share-record-sleep'
import { recoverWorkerReleaseProcessTree } from '../runtime/rpc/methods/orchestration-worker-release-policy-recovery'
import * as processTree from '../runtime/orchestration/worker-release-process-tree'
import { captureWorkerReviewHandoff } from './artifact-review-worker-checkpoint'
import {
  noteReleasedWorkerReviewsAsleep,
  workerReviewDeliveryHeld,
  workerReviewReleaseHold
} from './artifact-review-worker-release'
import { prepareReviewWake, type ReviewWakeDeps } from './artifact-review-wake'

const scope = {
  cloudUserId: 'user',
  cloudProfileId: 'cloud-profile',
  cloudOrganizationId: 'org',
  apiOrigin: 'https://omnios.example'
}
const state = vi.hoisted(() => ({ path: '', active: true }))
vi.mock('../omni-profiles/profile-storage-paths', async (original) => ({
  ...(await original<typeof ProfilePaths>()),
  getProfileUserDataPath: () => state.path
}))
vi.mock('./artifact-share-scope', () => ({
  activeArtifactShareScope: () => (state.active ? { profileId: 'profile', scope } : null)
}))

const resource: WorkerTerminalResourceRow = {
  id: 'resource',
  origin_dispatch_id: 'dispatch',
  owner_dispatch_id: 'dispatch',
  prior_owner_dispatch_ids: '[]',
  worktree_id: 'repo::/w',
  terminal_handle: 'terminal',
  pane_key: 'tab-1:leaf-1',
  process_incarnation: 'process-1',
  host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
  ownership_state: 'owned',
  release_state: 'releasing',
  retained_reason: null,
  release_requested_at: '2026-10-07',
  release_completed_at: null,
  release_error: null,
  archive_source: 'transcript',
  archive_status: 'captured',
  created_at: '2026-10-07',
  updated_at: '2026-10-07'
}
const sourceKey = '/w/result.md'
const record: ArtifactShareRecord = {
  ...scope,
  slug: 'result',
  editToken: 'kept-private',
  shareUrl: `${scope.apiOrigin}/result`,
  sourceReview: {
    ledgerId: 'als_0123456789abcdef01234567',
    nativeSessionId: 'conversation',
    paneKey: resource.pane_key!,
    worktreeId: resource.worktree_id!,
    account: 'account',
    revision: 3
  },
  sleep: {
    state: 'waiting',
    revision: 3,
    armedAt: 100,
    at: 100,
    provider: 'codex',
    accountHome: '/account',
    transcriptPath: '/account/sessions/rollout.jsonl',
    model: 'gpt-6',
    effort: 'xhigh',
    cwd: '/w',
    workspace: { kind: 'git', path: '/w', branch: 'review', worktreeId: resource.worktree_id! }
  }
}

describe('finite worker review handoff', () => {
  let archive: { content: string } | null
  let phase: 'prepared' | 'issued' | 'unknown'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    state.path = mkdtempSync(join(tmpdir(), 'worker-review-'))
    state.active = true
    archive = null
    phase = 'prepared'
    db = {
      getWorkerDispatch: () => ({ created_at: '2026-10-07' }),
      getWorkerTerminalArchive: () => archive,
      listWorkerTerminalUnsettledCloses: () => [resource],
      getWorkerTerminalReleaseClosePhase: () => phase
    } as unknown as OrchestrationDb
    runtime = {
      getArtifactApiOrigin: () => scope.apiOrigin,
      getExactWorkerProviderSession: () => ({
        agent: 'codex',
        processIncarnation: resource.process_incarnation,
        providerSession: { id: 'conversation', transcriptPath: record.sleep!.transcriptPath }
      })
    } as unknown as OrcaRuntimeService
    save(record)
  })

  afterEach(() => {
    rmSync(state.path, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function save(next: ArtifactShareRecord): void {
    saveArtifactShareRecord('profile', state.path, sourceKey, next)
  }
  function saved(): ArtifactShareRecord {
    return getArtifactShareRecord('profile', state.path, sourceKey, scope)!
  }
  function checkpoint(): void {
    archive = {
      content: JSON.stringify({
        reviewHandoff: captureWorkerReviewHandoff(runtime, resource),
        resume: {
          agent: 'codex',
          providerSessionKey: 'session_id',
          providerSessionId: 'conversation',
          transcriptPath: record.sleep!.transcriptPath,
          processIncarnation: resource.process_incarnation,
          execution: {
            hostname: hostname(),
            profilePath: state.path,
            hostScope: resource.host_scope,
            worktreeId: resource.worktree_id,
            worktreePath: '/w',
            accountChoiceId: 'account-id',
            accountHome: '/account'
          }
        }
      })
    }
  }

  it('preserves the durable Work wait and exact resume choices after confirmed exit', () => {
    expect(workerReviewReleaseHold(runtime, db, resource)).toBeNull()
    checkpoint()
    expect(workerReviewReleaseHold(runtime, db, resource)).toBeNull()
    expect(archive!.content).not.toContain('kept-private')
    noteReleasedWorkerReviewsAsleep(runtime, db, resource, 200)
    expect(saved().sleep).toEqual({ ...record.sleep, state: 'asleep', sleptAt: 200, at: 200 })
    expect(saved().sourceReview).toEqual(record.sourceReview)
    // Recovery repeats safely if the review write committed before resource settlement failed.
    noteReleasedWorkerReviewsAsleep(runtime, db, resource, 300)
    expect(saved().sleep?.sleptAt).toBe(200)
  })

  it('finishes the archived scope even after sign-out during physical close', () => {
    checkpoint()
    state.active = false
    expect(workerReviewReleaseHold(runtime, db, resource)).toContain('scope changed')
    noteReleasedWorkerReviewsAsleep(runtime, db, resource, 200)
    expect(saved().sleep?.state).toBe('asleep')
  })

  it('leaves failed persistence pending and retries the same review transition', () => {
    checkpoint()
    vi.spyOn(sleepStore, 'saveArtifactReviewSleep').mockReturnValueOnce(false)
    expect(() => noteReleasedWorkerReviewsAsleep(runtime, db, resource)).toThrow('will retry')
    expect(saved().sleep?.state).toBe('waiting')
    noteReleasedWorkerReviewsAsleep(runtime, db, resource)
    expect(saved().sleep?.state).toBe('asleep')
  })

  it('does not silently settle a review published after the release checkpoint', () => {
    save({ ...record, sourceReview: undefined, sleep: undefined })
    checkpoint()
    save(record)
    expect(workerReviewReleaseHold(runtime, db, resource)).toContain('scope changed')
    expect(() => noteReleasedWorkerReviewsAsleep(runtime, db, resource)).toThrow('review appeared')
    expect(saved().sleep?.state).toBe('waiting')
  })

  it.each([
    ['kept', undefined],
    ['missing account', { ...record.sleep!, accountHome: undefined }],
    ['wrong account', { ...record.sleep!, accountHome: '/other-account' }],
    ['missing workspace', { ...record.sleep!, workspace: undefined }],
    ['old revision', { ...record.sleep!, revision: 2 }],
    ['already acting on decision', { ...record.sleep!, state: 'awake' as const }]
  ] as const)('keeps %s review execution available', (_case, sleep) => {
    save({ ...record, sleep })
    expect(workerReviewReleaseHold(runtime, db, resource)).toContain('keep its execution')
    expect(saved().sleep).toEqual(sleep)
  })

  it.each(['prepared', 'sending', 'queued', 'uncertain'] as const)(
    'holds release while a decision receipt is %s',
    (status) => {
      save({
        ...record,
        sourceReview: {
          ...record.sourceReview!,
          receipt: { decisionId: 'decision', entryId: 'prompt', attempt: 0, status }
        }
      })
      expect(workerReviewReleaseHold(runtime, db, resource)).toContain('receiving a decision')
      expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(false)
    }
  )

  it('fences delivery only after close issue, including unknown legacy close phase', () => {
    expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(false)
    phase = 'issued'
    expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(true)
    phase = 'unknown'
    expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(true)
    expect(workerReviewDeliveryHeld(db, { ...record.sourceReview!, worktreeId: 'other' })).toBe(
      false
    )
    vi.spyOn(db, 'listWorkerTerminalUnsettledCloses').mockReturnValue([])
    expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(false)
  })

  it('keeps the delivery fence while an issued close has an unknown result', () => {
    // An unconfirmed close leaves release_state 'unknown' before the sleep receipt is saved; the
    // terminal may still be visible while its process is going away. Wake must wait for retry.
    phase = 'issued'
    vi.spyOn(db, 'listWorkerTerminalUnsettledCloses').mockReturnValue([
      { ...resource, release_state: 'unknown' }
    ])
    expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(true)
    vi.spyOn(db, 'listWorkerTerminalUnsettledCloses').mockReturnValue([
      { ...resource, release_state: 'released' }
    ])
    expect(workerReviewDeliveryHeld(db, record.sourceReview!)).toBe(false)
  })

  it('records sleep for a decision receipted during the physical close so wake delivers it', () => {
    checkpoint()
    const receipt = {
      decisionId: 'decision',
      entryId: 'prompt',
      attempt: 0,
      status: 'queued' as const
    }
    save({ ...record, sourceReview: { ...record.sourceReview!, receipt } })
    // Before the close the live worker is kept for the decision ...
    expect(workerReviewReleaseHold(runtime, db, resource)).toContain('keep its execution session')
    // ... after the exact exit the same receipt is a wake reason, never a permanent throw.
    noteReleasedWorkerReviewsAsleep(runtime, db, resource, 200)
    expect(saved().sleep).toMatchObject({ state: 'asleep', sleptAt: 200 })
    expect(saved().sourceReview?.receipt).toEqual(receipt)
  })

  it('records the newer revision asleep without rolling back its decision or binding', () => {
    checkpoint()
    const receipt = {
      decisionId: 'new-decision',
      entryId: 'prompt',
      attempt: 0,
      status: 'queued' as const
    }
    const replacement = {
      ...record,
      sourceReview: { ...record.sourceReview!, revision: 4, receipt },
      sleep: { ...record.sleep!, revision: 4 }
    }
    save(replacement)
    expect(workerReviewReleaseHold(runtime, db, resource)).toContain('scope changed')
    noteReleasedWorkerReviewsAsleep(runtime, db, resource, 200)
    expect(saved().sourceReview).toEqual(replacement.sourceReview)
    expect(saved().sleep).toEqual({ ...replacement.sleep, state: 'asleep', sleptAt: 200, at: 200 })
    noteReleasedWorkerReviewsAsleep(runtime, db, resource, 300)
    expect(saved().sleep?.sleptAt).toBe(200)
  })

  it('finishes exact-exit recovery for the newer revision without losing its decision', async () => {
    checkpoint()
    const value = JSON.parse(archive!.content)
    value.releaseProcessTree = {
      version: 1,
      processIncarnation: resource.process_incarnation,
      hostScope: resource.host_scope,
      snapshot: {
        root: { pid: 100, startedAt: 'Thu Oct 1 12:00:00 2026' },
        rootPgid: 100,
        descendants: [],
        capturedAtMs: 100
      }
    }
    archive = { content: JSON.stringify(value) }
    phase = 'issued'
    const replacement = {
      ...record.sourceReview!,
      revision: 4,
      receipt: { decisionId: 'decision', entryId: 'prompt', attempt: 0, status: 'queued' as const }
    }
    save({ ...record, sourceReview: replacement, sleep: { ...record.sleep!, revision: 4 } })
    let current = { ...resource }
    Object.assign(db, {
      getWorkerTerminalResource: () => current,
      workerTerminalResourceHasIdentityConflict: () => false,
      listWorkerTerminalUnsettledCloses: () => [current],
      settleWorkerTerminalRelease: vi.fn(() => {
        expect(saved().sleep).toMatchObject({ state: 'asleep', revision: 4 })
        current = { ...current, release_state: 'released', ownership_state: 'released' }
        return current
      })
    })
    Object.assign(runtime, {
      inspectTerminalProcessIncarnationLiveness: vi.fn(async () => 'exited')
    })
    vi.spyOn(processTree, 'finishWorkerReleaseProcessTree').mockResolvedValue('exited')
    expect(workerReviewDeliveryHeld(db, replacement)).toBe(true)
    for (let i = 0; i < 3; i++) {
      await recoverWorkerReleaseProcessTree({
        runtime,
        db,
        dispatchId: 'dispatch',
        resource: current
      })
    }
    expect(db.settleWorkerTerminalRelease).toHaveBeenCalledTimes(1)
    expect(workerReviewDeliveryHeld(db, replacement)).toBe(false)
    expect(saved().sourceReview).toEqual(replacement)
    expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledExactlyOnceWith(
      resource.process_incarnation,
      resource.host_scope
    )
  })

  it.each(['nativeSessionId', 'account', 'ledgerId', 'paneKey', 'worktreeId'] as const)(
    'refuses a newer revision whose %s changed',
    (field) => {
      checkpoint()
      const replacement = {
        ...record,
        sourceReview: { ...record.sourceReview!, revision: 4, [field]: 'different' },
        sleep: { ...record.sleep!, revision: 4 }
      }
      save(replacement)
      const before = saved()
      expect(() => noteReleasedWorkerReviewsAsleep(runtime, db, resource)).toThrow(
        'binding changed'
      )
      expect(saved()).toEqual(before)
    }
  )

  it('refuses a revision rollback after exit', () => {
    checkpoint()
    save({
      ...record,
      sourceReview: { ...record.sourceReview!, revision: 2 },
      sleep: { ...record.sleep!, revision: 2 }
    })
    expect(() => noteReleasedWorkerReviewsAsleep(runtime, db, resource)).toThrow('binding changed')
    expect(saved().sleep).toMatchObject({ state: 'waiting', revision: 2 })
  })

  it.each(['processIncarnation', 'providerSessionId', 'transcriptPath'] as const)(
    'refuses a mismatched archived %s',
    (field) => {
      checkpoint()
      const value = JSON.parse(archive!.content)
      value.resume[field] = 'different'
      archive = { content: JSON.stringify(value) }
      expect(workerReviewReleaseHold(runtime, db, resource)).toContain('archived resume')
      expect(() => noteReleasedWorkerReviewsAsleep(runtime, db, resource)).toThrow(
        'handoff changed'
      )
      expect(saved().sleep?.state).toBe('waiting')
    }
  )

  it.each([3, 4])(
    'wakes revision %s once with the archived session, account, model and effort',
    async (revision) => {
      checkpoint()
      save({
        ...record,
        sourceReview: { ...record.sourceReview!, revision },
        sleep: { ...record.sleep!, revision }
      })
      noteReleasedWorkerReviewsAsleep(runtime, db, resource)
      const entry = { sourceKey, slug: record.slug, sourceReview: saved().sourceReview! }
      const deps: ReviewWakeDeps = {
        readRows: async () => [],
        observe: vi.fn(),
        wakeBlocked: () => null,
        capacity: async () => ({ ok: true }),
        resume: vi.fn(async () => ({ summary: 'resumed' }) as never),
        restartParked: vi.fn(),
        paneHasTerminal: () => false,
        startedTerminal: () => false,
        ledgerFor: () => null,
        rebind: vi.fn(),
        audit: vi.fn(),
        now: () => 500,
        wakeClaimElsewhere: async () => null,
        withdrawWakeCopy: async () => 'ok',
        saveSleep: (expected, sleep) =>
          saveArtifactReviewSleep('profile', state.path, sourceKey, scope, expected, sleep)
      }
      await prepareReviewWake(deps, entry, saved().sleep)
      expect(deps.resume).toHaveBeenCalledExactlyOnceWith(
        'codex:conversation@local',
        expect.objectContaining({
          state: 'asleep',
          accountHome: '/account',
          cwd: '/w',
          model: 'gpt-6',
          effort: 'xhigh'
        })
      )
      expect(saved().sleep?.state).toBe('waking')
      await prepareReviewWake(deps, entry, saved().sleep)
      expect(deps.resume).toHaveBeenCalledTimes(1)
    }
  )
})
