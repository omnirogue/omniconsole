import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

const worker = vi.hoisted(() => ({ hold: null as string | null }))
vi.mock('../runtime/automatic-worker-cleanup-hold', () => ({
  readAutomaticWorkerCleanupHold: vi.fn(async () => worker.hold)
}))

const { readReviewSessionCleanupHold } = await import('./artifact-review-cleanup-hold')

const runtime = (automaticSessionCleanupProtection: unknown) =>
  ({
    getHeadlessSleepSettings: () => ({ automaticSessionCleanupProtection })
  }) as unknown as OrcaRuntimeService
const TARGET = { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1' }
const CONFIGURED = {
  protectedWorkspacePaths: [],
  protectedPaneKeys: [],
  protectStartedToday: true,
  timeZone: 'UTC'
}

describe('review session cleanup hold', () => {
  it('keeps everything while protections were never set, whatever the worker baseline says', async () => {
    expect(await readReviewSessionCleanupHold(runtime(null), TARGET)).toBe(
      'protection-unconfigured'
    )
    expect(await readReviewSessionCleanupHold(runtime(undefined), TARGET)).toBe(
      'protection-unconfigured'
    )
  })

  it('uses the worker hold (started-today lifted) once protections are set', async () => {
    expect(await readReviewSessionCleanupHold(runtime(CONFIGURED), TARGET)).toBeNull()
    worker.hold = 'pinned'
    expect(await readReviewSessionCleanupHold(runtime(CONFIGURED), TARGET)).toBe('pinned')
  })
})
