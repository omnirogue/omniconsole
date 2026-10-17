import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import { BuildReviewService } from './build-review-service'
import { getBuildReviewService } from './build-review-service-registry'
import {
  BUILD_REVIEW_RESTART_ERROR,
  BuildReviewPipelineStore,
  defaultBuildReviewPipelineDirectory
} from './build-review-pipeline-store'
import { createPipelineSnapshot, setStage } from './build-review-pipeline-state'
import type { OrchestrationCaller } from './build-review-rpc-call'
import {
  reviewFindingBlocks,
  type CheckedReviewFinding,
  type ReviewEvidence
} from '../../../shared/review-findings'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'build-review-pipelines-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('BuildReviewPipelineStore', () => {
  it('brings a settled run back exactly as it ended', () => {
    const dir = directory()
    const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'Ship it' })
    pipeline.error = 'builder: agent_prompt_stalled'
    setStage(pipeline, 'failed')
    new BuildReviewPipelineStore(dir).save(pipeline)
    expect(new BuildReviewPipelineStore(dir).load()).toEqual([pipeline])
  })

  it('fails a run the previous process died inside, once, in words', () => {
    const dir = directory()
    const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'Ship it' })
    setStage(pipeline, 'building')
    pipeline.builder.status = 'running'
    const store = new BuildReviewPipelineStore(dir)
    store.save(pipeline)
    store.flush()

    const [restored] = new BuildReviewPipelineStore(dir).load()
    expect(restored).toMatchObject({
      id: pipeline.id,
      stage: 'failed',
      error: BUILD_REVIEW_RESTART_ERROR,
      builder: { status: 'failed' },
      reviewer: { status: 'pending' }
    })
    const [again] = new BuildReviewPipelineStore(dir).load()
    expect(again!.events.filter((event) => event.text === BUILD_REVIEW_RESTART_ERROR)).toHaveLength(
      1
    )
  })

  it('migrates findings saved by an earlier check fail-closed, never unblocking one', () => {
    const dir = directory()
    const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'Ship it' })
    setStage(pipeline, 'failed')
    const quote = { kind: 'quote' as const, text: 'deploy on Friday' }
    const command = {
      kind: 'command' as const,
      program: 'node',
      args: ['-e', '1'],
      expect: 'fail' as const
    }
    const saved = (
      status: CheckedReviewFinding['status'],
      evidence?: ReviewEvidence,
      checkVersion?: number
    ) => ({
      id: `F${status}${evidence?.kind ?? ''}${checkVersion ?? ''}`,
      severity: 'blocker' as const,
      claim: 'x',
      status,
      ...(evidence ? { evidence } : {}),
      ...(checkVersion ? { checkVersion } : {})
    })
    const findings = () => [
      saved('confirmed', quote),
      saved('not-reproduced', quote),
      saved('confirmed', command),
      saved('not-reproduced', command),
      saved('unverified', command),
      saved('needs-evidence'),
      saved('not-reproduced', quote, 2),
      saved('confirmed', command, 2),
      saved('not-reproduced', command, 2),
      saved('not-reproduced', quote, 3),
      saved('confirmed', quote, 2),
      saved('confirmed', quote, 3),
      saved('confirmed', { kind: 'test', file: 'a.test.js' }, 3),
      saved('not-reproduced', { kind: 'test', file: 'a.test.js' }, 3),
      saved('located', { kind: 'test', file: 'a.test.js' }, 4),
      saved('not-reproduced', quote, 4),
      saved('confirmed', quote, 4),
      saved('located', quote, 5)
    ]
    const expected = [
      'located',
      'unverified',
      'located',
      'unverified',
      'unverified',
      'needs-evidence',
      'unverified',
      'located',
      'unverified',
      'unverified',
      'located',
      'located',
      'located',
      'unverified',
      'located',
      'unverified',
      'located',
      'located'
    ]
    pipeline.reviewer.findings = findings()
    pipeline.reviewers = [{ ...structuredClone(pipeline.reviewer), findings: findings() }]
    pipeline.rounds = [
      {
        number: 1,
        builder: pipeline.builder,
        reviewers: [{ ...pipeline.reviewer, findings: findings() }]
      }
    ]
    new BuildReviewPipelineStore(dir).save(pipeline)
    const [restored] = new BuildReviewPipelineStore(dir).load()
    for (const reviewer of [
      restored!.reviewer,
      restored!.reviewers![0]!,
      restored!.rounds![0]!.reviewers[0]!
    ]) {
      const before = findings().map((finding) => reviewFindingBlocks(finding))
      expect(reviewer.findings?.map((finding) => finding.status)).toEqual(expected)
      reviewer.findings!.forEach((finding, index) => {
        expect(reviewFindingBlocks(finding) || !before[index]).toBe(true)
      })
    }
  })

  it('skips files that are not runs and forgets evicted ones', () => {
    const dir = directory()
    const log = vi.fn()
    writeFileSync(join(dir, 'brp_broken.json'), '{not json')
    writeFileSync(join(dir, 'brp_other.json'), JSON.stringify({ id: 'brp_mismatch' }))
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    const store = new BuildReviewPipelineStore(dir, log)
    expect(store.load()).toEqual([])
    expect(log).toHaveBeenCalledTimes(2)
    const pipeline = createPipelineSnapshot({ worktree: 'id:x', objective: 'Gone soon' })
    setStage(pipeline, 'completed')
    store.save(pipeline)
    store.remove(pipeline.id)
    expect(readdirSync(dir).filter((name) => name.startsWith(pipeline.id))).toEqual([])
  })
})

describe('BuildReviewService restore', () => {
  it('lists the runs a previous process left, so a restart shows them as they ended', () => {
    const dir = directory()
    const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'Restored' })
    setStage(pipeline, 'reviewing')
    const store = new BuildReviewPipelineStore(dir)
    store.save(pipeline)
    store.flush()
    const runtime = { notifyBuildReviewChanged: vi.fn() } as unknown as OrcaRuntimeService
    const call = vi.fn() as unknown as OrchestrationCaller
    const service = new BuildReviewService(runtime, call, undefined, { directory: dir })
    expect(service.list()).toMatchObject([{ id: pipeline.id, stage: 'failed' }])
    expect(service.show(pipeline.id).error).toBe(BUILD_REVIEW_RESTART_ERROR)
  })

  it("keeps runs in memory unless the host names a directory; the host's service does", () => {
    // Every test process installs a fake app environment with a userData directory.
    const dir = defaultBuildReviewPipelineDirectory()!
    directories.push(dir)
    const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'Earlier' })
    setStage(pipeline, 'failed')
    new BuildReviewPipelineStore(dir).save(pipeline)
    const runtime = { notifyBuildReviewChanged: vi.fn() } as unknown as OrcaRuntimeService
    const call = vi.fn() as unknown as OrchestrationCaller
    expect(new BuildReviewService(runtime, call).list()).toEqual([])
    expect(getBuildReviewService(runtime).list()).toMatchObject([{ id: pipeline.id }])
  })
})
