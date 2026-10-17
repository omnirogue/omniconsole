import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildReviewService } from './build-review-service'
import { createFakeRuntime, createScriptedCaller } from './build-review-service-fixture'
import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'

vi.mock('./build-review-workspace-reservation', () => ({
  buildReviewWorkspaceKey: () => 'local-workspace',
  claimBuildReviewWorkspace: vi.fn(),
  bindBuildReviewRun: vi.fn(),
  markBuildReviewWorkerStart: vi.fn(),
  recordBuildReviewWorkerStart: vi.fn(),
  clearRejectedBuildReviewWorkerStart: vi.fn(),
  releaseBuildReviewWorkspace: vi.fn(() => true),
  ownerDefinitelyGone: vi.fn(() => true)
}))
vi.mock('./build-review-workspace-reconcile', () => ({
  buildReviewClaimOptions: vi.fn(async () => ({})),
  releaseSettledBuildReviewWorkspace: vi.fn(async () => null),
  heldErrorFacts: () => ({ reservation: null, open: [], missingEvidence: false, owner: null }),
  buildReviewWorkspaceHold: () => null
}))

// The coordinator is where the first side effect happens: count entries and capture the file by then.
const seen = vi.hoisted(() => ({
  onDisk: null as BuildReviewPipelineSnapshot | null,
  dir: '',
  coordinatorEntries: 0,
  failWrites: 0,
  /** The directory sync fails on the next strict write only, as a real EIO would reach it. */
  failStrictDirectorySync: false
}))
vi.mock('./build-review-coordinator', () => ({
  openCoordinator: vi.fn(async (_deps: unknown, pipeline: BuildReviewPipelineSnapshot) => {
    seen.coordinatorEntries += 1
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const raw = await readFile(join(seen.dir, `${pipeline.id}.json`), 'utf8')
    seen.onDisk = JSON.parse(raw) as BuildReviewPipelineSnapshot
    throw new Error('stop at the coordinator: the test only needs what was on disk by now')
  }),
  closeCoordinator: vi.fn(async () => true)
}))
// A disk that refuses the next N writes, the way ENOSPC or a permission change would.
vi.mock(import('../../durable-file-write'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    writeFileDurableSync: (
      temp: string,
      path: string,
      data: string,
      options?: { strictDirectorySync?: boolean }
    ) => {
      if (seen.failWrites > 0) {
        seen.failWrites -= 1
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      if (seen.failStrictDirectorySync && options?.strictDirectorySync) {
        seen.failStrictDirectorySync = false
        // The file is published; only its directory entry's sync failed, as the real writer reports.
        actual.writeFileDurableSync(temp, path, data)
        throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
      }
      actual.writeFileDurableSync(temp, path, data, options)
    }
  }
})

const NOW = 1_800_000_000_000
const LOCAL = { hostname: 'macserver-0-01.local', cores: 24, load1: 6 }

async function settle(service: BuildReviewService, id: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const stage = service.show(id).stage
    if (stage === 'completed' || stage === 'failed' || stage === 'cancelled') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('pipeline never settled')
}

const dirs: string[] = []
afterEach(async () => {
  seen.onDisk = null
  seen.coordinatorEntries = 0
  seen.failWrites = 0
  seen.failStrictDirectorySync = false
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function serviceOnDisk() {
  const dir = await mkdtemp(join(tmpdir(), 'build-review-durability-'))
  dirs.push(dir)
  seen.dir = dir
  const { runtime } = createFakeRuntime()
  const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
  const service = new BuildReviewService(runtime, caller, undefined, {
    directory: dir,
    placement: { hostsFile: join(dir, 'no-hosts.json'), local: LOCAL, now: () => NOW }
  })
  return { dir, service, calls }
}

describe('Build + Review placement durability', () => {
  it('has the decided placement on disk before the coordinator opens', async () => {
    const { dir, service } = await serviceOnDisk()
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Review the queue',
      runsOn: 'local'
    })
    await settle(service, started.id)
    // The store's debounced save must not be what carries the decision: it was written first.
    expect(seen.coordinatorEntries).toBe(1)
    expect(seen.onDisk?.placement).toEqual({ runsOn: 'local', mode: 'local' })
    expect(seen.onDisk?.events.map((event) => event.text)).toContain(
      'Workers run on this computer (chosen explicitly)'
    )
    const final = JSON.parse(
      await readFile(join(dir, `${started.id}.json`), 'utf8')
    ) as BuildReviewPipelineSnapshot
    expect(final.stage).toBe('failed')
    expect(final.placement).toEqual({ runsOn: 'local', mode: 'local' })
  })

  it('refuses by name and opens no coordinator when the placement cannot be written', async () => {
    const { service, calls } = await serviceOnDisk()
    seen.failWrites = 1
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Review the queue',
      runsOn: 'local'
    })
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('failed')
    expect(shown.error).toMatch(
      /^The placement could not be recorded on disk \(ENOSPC: no space left on device\); nothing was started\.$/
    )
    expect(seen.coordinatorEntries).toBe(0)
    expect(calls.map((call) => call.method)).not.toContain('orchestration.runCreate')
    expect(calls.map((call) => call.method)).not.toContain('orchestration.workerStart')
  })

  it('refuses when only the directory sync of the placement record fails', async () => {
    const { service, calls } = await serviceOnDisk()
    seen.failStrictDirectorySync = true
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Review the queue',
      runsOn: 'local'
    })
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('failed')
    expect(shown.error).toBe(
      'The placement could not be recorded on disk (EIO: i/o error, fsync); nothing was started.'
    )
    expect(seen.coordinatorEntries).toBe(0)
    expect(calls.map((call) => call.method)).not.toContain('orchestration.runCreate')
  })
})
