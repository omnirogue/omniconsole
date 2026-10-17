import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildReviewService } from './build-review-service'
import { createFakeRuntime, createScriptedCaller } from './build-review-service-fixture'
import type { BuildReviewWorkspaceHeldError } from './build-review-workspace-evidence'

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

// Placement has its own tests (build-review-fleet-placement.test.ts); here this computer is
// the verified host so the gates under test are reached.
vi.mock(import('../workflow-script/local-workflow-fleet-placement'), async (importOriginal) => ({
  ...(await importOriginal()),
  placeLocalWorkflow: vi.fn(async (runsOn: 'fleet' | 'local' | undefined) => ({
    runsOn: runsOn ?? 'fleet',
    mode: 'local' as const
  }))
}))

type HoldFactsFixture = { reservation: { pipeline_id: string; run_id: string | null } }
const reconcile = vi.hoisted(() => ({
  claimOptions: vi.fn(async () => ({})),
  releaseSettled: vi.fn(
    async (_deps: unknown, _key: string, _mode: 'observe' | 'release'): Promise<unknown> => null
  )
}))
// The reservation itself is covered against a real database in its own tests.
vi.mock('./build-review-workspace-reconcile', () => ({
  buildReviewClaimOptions: reconcile.claimOptions,
  releaseSettledBuildReviewWorkspace: reconcile.releaseSettled,
  heldErrorFacts: (error: BuildReviewWorkspaceHeldError) => ({
    reservation: error.reservation,
    open: [],
    missingEvidence: false,
    owner: null
  }),
  buildReviewWorkspaceHold: (facts: HoldFactsFixture) => ({
    pipelineId: facts.reservation.pipeline_id,
    runId: facts.reservation.run_id,
    items: []
  })
}))

async function settle(service: BuildReviewService, id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const stage = service.show(id).stage
    if (stage === 'completed' || stage === 'failed' || stage === 'cancelled') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('pipeline never settled')
}

beforeEach(() => {
  reconcile.claimOptions.mockResolvedValue({})
  reconcile.releaseSettled.mockReset()
  reconcile.releaseSettled.mockResolvedValue(null)
})

describe('Build + Review approval gates', () => {
  it('tells the next builder about its failed build even when a reviewer also asked for changes', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'failed',
      bodies: ['half done', 'VERDICT: REQUEST_CHANGES\nFix the null case.']
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Fix it',
      reviewers: [{ agent: 'claude', model: 'opus' }],
      maxReviewRounds: 2
    })
    await settle(service, id)
    const briefs = calls
      .filter((call) => call.method === 'orchestration.taskCreate')
      .map((call) => JSON.stringify(call.params))
    // Round 2's builder brief (the third task) carries both the review and the build failure.
    expect(briefs[2]).toContain('Fix the null case.')
    expect(briefs[2]).toContain('the builder reported failure this round')
    expect(service.show(id).stage).toBe('completed')
  })

  it('does not block on a blocker without evidence; it goes forward as a suggestion', async () => {
    const { runtime } = createFakeRuntime()
    const findings = `OMNI_FINDINGS: ${JSON.stringify({
      findings: [{ id: 'F1', severity: 'blocker', claim: 'Feels wrong' }]
    })}`
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: ['built', `Looks off.\n${findings}\nVERDICT: REQUEST_CHANGES`]
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Fix it',
      reviewers: [{ agent: 'claude', model: 'opus' }]
    })
    await settle(service, id)
    const done = service.show(id)
    expect(done.stage).toBe('completed')
    expect(done.reviewers?.[0]?.findings?.[0]).toMatchObject({ id: 'F1', status: 'needs-evidence' })
    expect(done.events.some((event) => event.text.includes('no blocker held up'))).toBe(true)
  })

  it('withholds approval for a blocker whose evidence cannot be checked on this host', async () => {
    const { runtime } = createFakeRuntime()
    const findings = `OMNI_FINDINGS: ${JSON.stringify({
      findings: [
        {
          id: 'F1',
          severity: 'blocker',
          claim: 'Crashes on null',
          evidence: { kind: 'command', program: 'node', args: ['repro.js'], expect: 'fail' }
        }
      ]
    })}`
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: ['built', `${findings}\nVERDICT: APPROVE`]
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Fix it',
      reviewers: [{ agent: 'claude', model: 'opus' }]
    })
    await settle(service, id)
    const done = service.show(id)
    // The fake runtime cannot resolve a local workspace, so the repro stays unverified.
    expect(done.stage).toBe('failed')
    expect(done.reviewers?.[0]?.findings?.[0]).toMatchObject({ status: 'unverified' })
    expect(done.events.some((event) => event.text.includes('approval is withheld'))).toBe(true)
  })

  it('keeps the verdict rule when evidence is turned off', async () => {
    const { runtime } = createFakeRuntime()
    const findings = `OMNI_FINDINGS: ${JSON.stringify({
      findings: [{ id: 'F1', severity: 'blocker', claim: 'Feels wrong' }]
    })}`
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: ['built', `${findings}\nVERDICT: REQUEST_CHANGES`]
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Fix it',
      reviewers: [{ agent: 'claude', model: 'opus' }],
      evidence: 'off'
    })
    await settle(service, id)
    expect(service.show(id).stage).toBe('failed')
  })

  it('refuses to retry a restored run whose reviewer is the builder model', async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({ worktree: 'id:x', objective: 'Build' })
    await settle(service, id)
    const live = (
      service as unknown as {
        pipelines: Map<string, { builder: { choice: unknown }; stage: string }>
      }
    ).pipelines.get(id)!
    live.builder.choice = { agent: 'claude', model: 'opus' }
    live.stage = 'failed'
    await expect(service.retry(id)).rejects.toThrow("builder's own model")
  })
})
