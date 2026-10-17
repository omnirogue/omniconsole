import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'
import type { WakeCopyApi } from './review-wake-copy-api'

const built = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('./review-wake-copy-source', () => ({ buildWakeCopy: vi.fn(async () => built.value) }))
vi.mock('../session-host/session-host-runtime', () => ({
  activeRuntimeSessionHost: () => ({ current: () => ({ identity: { hostId: 'host_mac' } }) })
}))
vi.mock('./artifact-source-state-report', () => ({ reviewHostLabel: async () => 'MacBook' }))
vi.mock('./session-written-files-store', () => ({ getSessionWrittenFilesStore: () => null }))

const { createWakeCopyUploads } = await import('./review-wake-copy-pass')

function entry(sleep: Partial<ArtifactReviewSleep>): ReviewSleepEntry {
  return {
    sourceKey: '/w/plan.md',
    slug: 'plan',
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'conv',
      paneKey: 'p',
      worktreeId: 'w',
      account: 'a',
      revision: 2
    },
    sleep: { state: 'asleep', revision: 2, armedAt: 1, at: 1, provider: 'claude', ...sleep }
  }
}

const COPY = {
  blob: Buffer.from('x'),
  sha256: 'b'.repeat(64),
  header: {
    revision: 2,
    provider: 'claude',
    writerVersion: null,
    workspace: { kind: 'folder', workRelativePath: 'X' }
  }
}
const UP = { revision: 2, at: 1, sha256: 'b'.repeat(64) }

function harness(entries: ReviewSleepEntry[], running: boolean | null = false) {
  const saved: unknown[] = []
  const reopened: string[] = []
  const api = vi.fn(async (_path: string, _options?: unknown) => ({
    status: 'ok' as const,
    value: {}
  }))
  const beat = vi.fn(async () => {})
  const run = createWakeCopyUploads({
    api: api as unknown as WakeCopyApi,
    entries: () => entries,
    saveWakeCopy: (_entry, copy) => saved.push(copy) > 0,
    markReopened: (target) => reopened.push(target.slug) > 0,
    running: async () => running,
    beat,
    now: () => 1_000
  })
  return { run, api, saved, reopened, beat }
}

describe('wake copy uploads', () => {
  it('uploads one copy per asleep revision, pending until OmniOS confirms, beating between parts', async () => {
    built.value = COPY
    const { run, api, saved, beat } = harness([entry({})])
    await run()
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      '/plan/wake-copy',
      '/plan/wake-copy/parts/0?revision=2',
      '/plan/wake-copy/complete'
    ])
    // Once before building, once before the part.
    expect(beat).toHaveBeenCalledTimes(2)
    expect(saved).toEqual([
      { revision: 2, at: 1_000, pending: true },
      { revision: 2, at: 1_000, sha256: 'b'.repeat(64) }
    ])
    const again = harness([entry({ wakeCopy: UP }), entry({ state: 'waiting' })])
    await again.run()
    expect(again.api).not.toHaveBeenCalled()
  })

  it('never uploads while the conversation runs, or when that cannot be told', async () => {
    built.value = COPY
    const unknown = harness([entry({})], null)
    await unknown.run()
    expect(unknown.api).not.toHaveBeenCalled()
    const reopened = harness([entry({})], true)
    await reopened.run()
    expect(reopened.api).not.toHaveBeenCalled()
    expect(reopened.reopened).toEqual(['plan'])
  })

  it('never copies a wait that ran here again since it slept, nor one whose pending mark did not save', async () => {
    built.value = COPY
    const reopened = harness([entry({ reopened: true })])
    await reopened.run()
    expect(reopened.api).not.toHaveBeenCalled()
    const unsaved = harness([entry({})])
    const run = (await import('./review-wake-copy-pass')).createWakeCopyUploads({
      api: unsaved.api as unknown as WakeCopyApi,
      entries: () => [entry({})],
      saveWakeCopy: () => false,
      markReopened: () => true,
      running: async () => false,
      beat: async () => {},
      now: () => 1_000
    })
    await run()
    expect(unsaved.api).not.toHaveBeenCalled()
  })

  it('withdraws a copy once its session runs here again or woke, until OmniOS confirms', async () => {
    const live = harness([entry({ wakeCopy: UP })], true)
    await live.run()
    expect(live.api).toHaveBeenCalledWith('/plan/wake-copy', { method: 'DELETE' })
    expect(live.saved).toEqual([{ revision: 2, at: 1_000 }])
    expect(live.reopened).toEqual(['plan'])
    const awake = harness([
      entry({ state: 'awake', wakeCopy: { revision: 2, at: 1, pending: true } })
    ])
    awake.api.mockResolvedValueOnce({ status: 'failed' } as never)
    await awake.run()
    expect(awake.saved).toEqual([])
  })

  it('records why a session cannot move, never rebuilds a final refusal, and leaves an older OmniOS alone', async () => {
    built.value = { refused: 'unpushed changes' }
    const refused = harness([entry({})])
    await refused.run()
    expect(refused.saved).toEqual([{ revision: 2, at: 1_000, refused: 'unpushed changes' }])
    const final = harness([
      entry({ wakeCopy: { revision: 2, at: -10_000_000, refused: 'too large' } })
    ])
    await final.run()
    expect(final.saved).toEqual([])
    built.value = COPY
    const old = harness([entry({})])
    old.api.mockResolvedValue({ status: 'unsupported' } as never)
    await old.run()
    expect(old.saved.at(-1)).toEqual({ revision: 2, at: 1_000, refused: 'not available yet' })
  })
})
