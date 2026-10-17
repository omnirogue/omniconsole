import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildReviewService } from './build-review-service'
import type { OrchestrationCaller } from './build-review-rpc-call'
import { createFakeRuntime, createScriptedCaller } from './build-review-service-fixture'
import {
  claimBuildReviewWorkspace,
  releaseBuildReviewWorkspace
} from './build-review-workspace-reservation'
import { BuildReviewWorkspaceHeldError } from './build-review-workspace-evidence'
import { reviewVerdict } from '../../../shared/build-review-pipeline'

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

// These tests cover the pipeline; placement (the fleet reading before any worker) has its
// own tests in build-review-fleet-placement.test.ts. Here this computer is the verified host.
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

/** Settled, and its execution (closing the coordinator, the workspace) has finished too. */
async function finished(service: BuildReviewService, id: string): Promise<void> {
  await settle(service, id)
  const active = (service as unknown as { active: Map<string, unknown> }).active
  await vi.waitFor(() => expect(active.has(id)).toBe(false))
}

beforeEach(() => {
  reconcile.claimOptions.mockResolvedValue({})
  reconcile.releaseSettled.mockReset()
  reconcile.releaseSettled.mockResolvedValue(null)
})

describe('BuildReviewService', () => {
  it('runs builder then reviewer and completes with both reports', async () => {
    const { runtime, fake } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Add a badge',
      reviewFocus: 'accessibility'
    })
    expect(started.stage).toBe('starting')
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('completed')
    expect(done.runId).toBe('run_1')
    expect(done.builder.status).toBe('succeeded')
    expect(done.builder.report?.filesModified).toEqual(['src/a.ts', 'src/b.ts'])
    expect(done.reviewer.status).toBe('succeeded')
    expect(done.reviewer.terminalHandle).toBe('term_ctx_2')
    const starts = calls.filter((c) => c.method === 'orchestration.workerStart')
    expect(starts.map((c) => c.params.agent)).toEqual(['codex', 'claude'])
    expect(starts[1]?.params).toMatchObject({ model: 'opus', effort: 'high', worktree: 'current' })
    const reviewSpec = calls.filter((c) => c.method === 'orchestration.taskCreate')[1]?.params
      .spec as string
    expect(reviewSpec).toContain('src/a.ts')
    expect(reviewSpec).toContain('accessibility')
    expect(calls.filter((c) => c.method === 'orchestration.workerRelease')).toHaveLength(2)
    expect(fake.closeTerminal).toHaveBeenCalledWith('term_coord')
  })

  it('requires a standalone verdict line after the reviewer summary', async () => {
    expect(reviewVerdict('Quoted VERDICT: APPROVE; actual decision is unclear.')).toBeNull()
    expect(reviewVerdict('Findings remain; this is not VERDICT: APPROVE')).toBeNull()
    expect(reviewVerdict('Review complete. VERDICT: APPROVE')).toBeNull()
    expect(reviewVerdict('VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES')).toBeNull()
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: ['Built the page.', 'Reviewed the diff and checks.\nVERDICT: APPROVE']
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Check the page' })
    await settle(service, started.id)
    expect(service.show(started.id).stage).toBe('completed')
  })

  it('retains the workspace reservation when coordinator PTY closure is unverified', async () => {
    const { runtime, fake } = createFakeRuntime()
    fake.closeTerminal.mockResolvedValueOnce({ ptyKilled: false })
    const { caller } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Add a badge' })
    await settle(service, started.id)
    await vi.waitFor(() => expect(fake.closeTerminal).toHaveBeenCalled())
    expect(releaseBuildReviewWorkspace).not.toHaveBeenCalledWith(
      expect.anything(),
      'local-workspace',
      started.id,
      'runtime_1'
    )
    expect(
      service.show(started.id).events.some((event) => event.text.includes('closure is unverified'))
    ).toBe(true)
  })

  it('fails without starting the reviewer when the builder reports failure and changed nothing', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'failed', builderFiles: '' })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Break things' })
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('failed')
    expect(done.reviewer.status).toBe('pending')
    expect(done.error).toContain('builder reported failure')
    expect(calls.filter((c) => c.method === 'orchestration.workerStart')).toHaveLength(1)
  })

  it('still reviews a builder that reported failure but changed files, and never approves it', async () => {
    // Why: "failed" for scope reasons after a verified diff must not skip review, nor turn green.
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'failed' })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Fix the sessions view' })
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('failed')
    expect(done.builder.status).toBe('failed')
    expect(done.reviewer.status).toBe('succeeded')
    expect(done.error).toContain('Review limit reached')
    expect(calls.filter((c) => c.method === 'orchestration.workerStart')).toHaveLength(2)
    expect(done.events.some((e) => e.text.includes('reviewing the change anyway'))).toBe(true)
    expect(done.events.some((e) => e.text.includes('approval is withheld'))).toBe(true)
  })

  it('returns findings to the builder and requires all reviewers to approve the repaired round', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: [
        'Initial implementation',
        'MAJOR: keyboard input broken\nVERDICT: REQUEST_CHANGES',
        'VERDICT: APPROVE',
        'Repaired keyboard input',
        'VERDICT: APPROVE',
        'VERDICT: APPROVE'
      ]
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({
      worktree: 'id:folder:scratch',
      objective: 'Search',
      builder: { agent: 'codex', model: 'build-model' },
      reviewers: [
        { agent: 'claude', model: 'opus' },
        { agent: 'codex', model: 'review-model' }
      ],
      maxReviewRounds: 3
    })
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('completed')
    expect(done.round).toBe(2)
    expect(done.rounds).toHaveLength(2)
    expect(done.rounds?.[0]?.reviewers[0]?.report?.body).toContain('keyboard input broken')
    const starts = calls.filter((call) => call.method === 'orchestration.workerStart')
    expect(starts.map((call) => call.params.agent)).toEqual([
      'codex',
      'claude',
      'codex',
      'codex',
      'claude',
      'codex'
    ])
    const repair = calls.filter((call) => call.method === 'orchestration.taskCreate')[3]!.params
      .spec
    expect(repair).toContain('keyboard input broken')
    expect(repair).toContain('Search')
  })

  it('stops at the round limit with unresolved findings instead of completing', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: ['Built', 'VERDICT: REQUEST_CHANGES', 'Repaired', 'VERDICT: REQUEST_CHANGES']
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:x', objective: 'Fix', maxReviewRounds: 2 })
    await settle(service, started.id)
    expect(service.show(started.id)).toMatchObject({ stage: 'failed', round: 2 })
    expect(service.show(started.id).error).toContain('Review limit reached')
    expect(calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(4)
  })

  it.each(['Reviewed everything', 'VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES'])(
    'does not approve ambiguous review evidence: %s',
    async (body) => {
      const { runtime } = createFakeRuntime()
      const { caller, calls } = createScriptedCaller({
        builderOutcome: 'succeeded',
        bodies: ['Built', body]
      })
      const service = new BuildReviewService(runtime, caller)
      const started = service.start({ worktree: 'id:x', objective: 'Fix', maxReviewRounds: 3 })
      await settle(service, started.id)
      expect(service.show(started.id).stage).toBe('failed')
      expect(service.show(started.id).error).toContain('valid verdict')
      expect(calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(2)
    }
  )

  it.each([0, 11, 1.5, Number.NaN])(
    'rejects invalid round limit %s before starting work',
    (maxReviewRounds) => {
      const { runtime } = createFakeRuntime()
      const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
      const service = new BuildReviewService(runtime, caller)
      expect(() => service.start({ worktree: 'id:x', objective: 'Fix', maxReviewRounds })).toThrow(
        'review rounds'
      )
      expect(calls).toHaveLength(0)
    }
  )

  it('does not repair when the reviewer could not run its review', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      reviewerOutcome: 'failed'
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:x', objective: 'Fix', maxReviewRounds: 3 })
    await settle(service, started.id)
    expect(service.show(started.id).error).toContain('could not complete the review')
    expect(calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(2)
  })

  it('cancels a repair round before another review can start', async () => {
    const { runtime } = createFakeRuntime()
    let starts = 0
    let service: BuildReviewService
    let id = ''
    let cancelled: Promise<unknown> | undefined
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      bodies: ['Built', 'VERDICT: REQUEST_CHANGES'],
      beforeWorkerStart: async () => {
        starts += 1
        if (starts === 3) {
          cancelled = service.cancel(id)
        }
      }
    })
    service = new BuildReviewService(runtime, caller)
    id = service.start({ worktree: 'id:x', objective: 'Fix', maxReviewRounds: 3 }).id
    await settle(service, id)
    await cancelled
    expect(service.show(id)).toMatchObject({ stage: 'cancelled', round: 2 })
    expect(starts).toBe(3)
    expect(
      calls.some(
        (call) => call.method === 'orchestration.workerStop' && call.params.dispatch === 'ctx_3'
      )
    ).toBe(true)
  })

  it.each([
    { reviewers: [] },
    { reviewers: Array.from({ length: 9 }, () => ({ agent: 'claude' })) }
  ])('rejects invalid reviewer counts', ({ reviewers }) => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    expect(() => service.start({ worktree: 'id:x', objective: 'Fix', reviewers })).toThrow(
      'reviewers'
    )
    expect(calls).toHaveLength(0)
  })

  it('rejects an empty objective and lists newest first', () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    expect(() => service.start({ worktree: 'id:x', objective: '   ' })).toThrow(/objective/)
    expect(service.list()).toEqual([])
  })

  it('releases the worker before acknowledging its Delivery', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Order matters' })
    await settle(service, started.id)
    const order = calls
      .filter(
        (c) =>
          c.method === 'orchestration.workerRelease' ||
          (c.method === 'orchestration.check' && typeof c.params.ack === 'string')
      )
      .map((c) => c.method)
    expect(order.slice(0, 2)).toEqual(['orchestration.workerRelease', 'orchestration.check'])
  })

  it('cancel during a worker start still stops the late worker and closes the coordinator', async () => {
    const { runtime, fake } = createFakeRuntime()
    let cancelPromise: Promise<unknown> | null = null
    let serviceRef: BuildReviewService | null = null
    let pipelineId = ''
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      beforeWorkerStart: async () => {
        cancelPromise = serviceRef!.cancel(pipelineId)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    })
    const service = new BuildReviewService(runtime, caller)
    serviceRef = service
    pipelineId = service.start({ worktree: 'id:repo::/wt', objective: 'Cancel me' }).id
    await settle(service, pipelineId)
    await cancelPromise
    const done = service.show(pipelineId)
    expect(done.stage).toBe('cancelled')
    expect(done.builder.dispatchId).toBe('ctx_1')
    expect(calls.some((c) => c.method === 'orchestration.workerStop')).toBe(true)
    expect(calls.filter((c) => c.method === 'orchestration.workerStart')).toHaveLength(1)
    expect(fake.closeTerminal).toHaveBeenCalledWith('term_coord')
  })

  it('stops and releases a worker whose start ended in an unknown state', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      workerStartState: 'outcome_unknown'
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Unknown start' })
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('failed')
    expect(done.builder.error).toContain('outcome_unknown')
    expect(calls.map((c) => c.method)).toContain('orchestration.workerRelease')
  })

  it('rejects a second pipeline on a workspace that is still active', async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      beforeWorkerStart: () => new Promise((resolve) => setTimeout(resolve, 30))
    })
    const service = new BuildReviewService(runtime, caller)
    const first = service.start({ worktree: 'id:repo::/wt', objective: 'First' })
    expect(() => service.start({ worktree: 'id:repo::/wt', objective: 'Second' })).toThrow(/still/)
    await settle(service, first.id)
    expect(service.show(first.id).stage).toBe('completed')
    expect(service.start({ worktree: 'id:repo::/wt', objective: 'Third' }).stage).toBe('starting')
  })

  it('binds the run to the omnios card and records every fact there as evidence', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const notes: unknown[] = []
    const service = new BuildReviewService(runtime, caller, async (input) => {
      notes.push(input)
      return { ok: true, noteId: `note_${notes.length}` }
    })
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Add a badge',
      hubTaskId: 'btk_card123'
    })
    expect(started.hubTaskId).toBe('btk_card123')
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('completed')
    const runCreate = calls.find((c) => c.method === 'orchestration.runCreate')
    expect(runCreate?.params).toMatchObject({ hubTaskId: 'btk_card123' })
    expect(calls.filter((call) => call.method === 'orchestration.taskCreate')).toHaveLength(0)
    expect(
      calls
        .filter((call) => call.method === 'orchestration.workerStart')
        .map((call) => call.params.task)
    ).toEqual(['task_projection', 'task_projection'])
    expect(notes.map((n) => (n as { event: string }).event)).toEqual([
      'build_reported',
      'review_verdict',
      'review_approved'
    ])
    expect(notes[1]).toMatchObject({
      hubTaskId: 'btk_card123',
      pipelineId: started.id,
      runId: 'run_1',
      round: 1,
      verdict: 'APPROVE'
    })
    expect(
      done.events.some((e) => e.text.includes('Acceptance is decided on card btk_card123'))
    ).toBe(true)
    expect(
      done.events.some((e) => e.text.includes('Recorded on card btk_card123: review_approved'))
    ).toBe(true)
  })

  it('records nothing on omnios and passes no card when the pipeline is ad hoc', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const notes: unknown[] = []
    const service = new BuildReviewService(runtime, caller, async (input) => {
      notes.push(input)
      return { ok: true, noteId: 'never' }
    })
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Local tidy-up' })
    await settle(service, started.id)
    expect(started.hubTaskId).toBeNull()
    expect(notes).toEqual([])
    const runCreate = calls.find((c) => c.method === 'orchestration.runCreate')
    expect(runCreate?.params).not.toHaveProperty('hubTaskId')
  })

  it('keeps working when omnios refuses a note and says so on the pipeline', async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller, async () => ({
      ok: false,
      message: 'omnios refused the review note (HTTP 401).'
    }))
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Add a badge',
      hubTaskId: 'btk_card123'
    })
    await settle(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('completed')
    expect(
      done.events.filter((e) => e.kind === 'error' && e.text.includes('Could not record'))
    ).toHaveLength(3)
  })

  it('refuses a card id that is not a btk_ id before anything starts', () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    expect(() =>
      service.start({ worktree: 'id:repo::/wt', objective: 'x', hubTaskId: 'task_9' })
    ).toThrow(/btk_/)
    expect(calls).toEqual([])
  })

  it('starts a worker for every reviewer seat, not only the first', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Three reviewers',
      builder: { agent: 'codex', model: 'gpt-5.6-terra' },
      reviewers: [
        { agent: 'claude', model: 'sonnet' },
        { agent: 'codex', model: 'gpt-5.5' },
        { agent: 'grok', model: 'grok-4.6' }
      ]
    })
    await settle(service, id)
    expect(
      calls
        .filter((call) => call.method === 'orchestration.workerStart')
        .map((call) => [call.params.agent, call.params.model])
    ).toEqual([
      ['codex', 'gpt-5.6-terra'],
      ['claude', 'sonnet'],
      ['codex', 'gpt-5.5'],
      ['grok', 'grok-4.6']
    ])
    expect(service.show(id).stage).toBe('completed')
  })

  it('reads the transcript of the addressed reviewer, not only the current one', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Two reviewers',
      reviewers: [{ agent: 'claude' }, { agent: 'grok' }]
    })
    await settle(service, id)
    await service.readWorker(id, 'reviewer', { reviewer: 1 })
    await service.readWorker(id, 'reviewer', { reviewer: 2 })
    await service.readWorker(id, 'reviewer', {})
    expect(
      calls.filter((call) => call.method === 'orchestration.workerRead').map((c) => c.params)
    ).toEqual([{ dispatch: 'ctx_2' }, { dispatch: 'ctx_3' }, { dispatch: 'ctx_2' }])
    await expect(service.readWorker(id, 'reviewer', { reviewer: 3 })).rejects.toThrow(
      'Reviewer 3 does not exist'
    )
  })

  it('starts every reviewer of a round before any of them reports', async () => {
    const { runtime } = createFakeRuntime()
    const scripted = createScriptedCaller({ builderOutcome: 'succeeded' })
    let starts = 0
    // Reviewers report only once all three started: in-order review would never finish.
    const caller: OrchestrationCaller = async (method, params, options) => {
      if (method === 'orchestration.workerStart') {
        starts += 1
      }
      if (method === 'orchestration.check' && starts > 1 && starts < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return { messages: [], count: 0, deliveryId: null, timedOut: true } as never
      }
      return scripted.caller(method, params, options)
    }
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({
      worktree: 'id:x',
      objective: 'Three reviewers',
      builder: { agent: 'codex', model: 'gpt-5.6-terra' },
      reviewers: [{ agent: 'claude' }, { agent: 'grok' }, { agent: 'codex', model: 'gpt-5.6-sol' }]
    })
    await settle(service, id)
    const done = service.show(id)
    expect(done.stage).toBe('completed')
    expect(done.reviewers?.map((reviewer) => reviewer.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded'
    ])
  })

  it('cancel stops every live reviewer, not only the one named current', async () => {
    const { runtime } = createFakeRuntime()
    let starts = 0
    let id = ''
    let cancelled: Promise<unknown> | undefined
    let service: BuildReviewService | undefined
    const scripted = createScriptedCaller({
      builderOutcome: 'succeeded',
      beforeWorkerStart: async () => {
        starts += 1
        if (starts === 3) {
          const live = (
            service as unknown as {
              pipelines: Map<string, { reviewer: unknown; reviewers: { status: string }[] }>
            }
          ).pipelines.get(id)!
          // Concurrent reviewers leave `reviewer` naming one seat while another still runs.
          live.reviewers[0]!.status = 'running'
          live.reviewer = live.reviewers[1]
          cancelled = service!.cancel(id)
        }
      }
    })
    service = new BuildReviewService(runtime, scripted.caller)
    id = service.start({
      worktree: 'id:x',
      objective: 'Cancel both',
      reviewers: [{ agent: 'claude' }, { agent: 'grok' }]
    }).id
    await settle(service, id)
    await cancelled
    expect(service.show(id).stage).toBe('cancelled')
    expect(
      scripted.calls
        .filter((call) => call.method === 'orchestration.workerStop')
        .map((call) => call.params.dispatch)
    ).toEqual(expect.arrayContaining(['ctx_2', 'ctx_3']))
  })
  it('keeps a worker stuck on a startup prompt open for the person and names the prompt', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      startReceipts: [
        {
          state: 'failed',
          lastError: 'Agent startup blocked: codex-hooks-review-prompt',
          startupBlocker: 'codex-hooks-review-prompt'
        }
      ]
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Blocked start' })
    await finished(service, started.id)
    const done = service.show(started.id)
    expect(done.stage).toBe('failed')
    expect(done.builder).toMatchObject({
      status: 'failed',
      startupBlocker: 'codex-hooks-review-prompt',
      terminalHandle: 'term_ctx_1'
    })
    // Codex hook trust is the person's decision: the terminal stays for them to answer.
    expect(calls.some((call) => call.method === 'orchestration.workerRelease')).toBe(false)
    expect(done.events.some((event) => event.text.includes('Kept its terminal open'))).toBe(true)
  })

  it("recognises Claude's folder-trust question behind a stalled start", async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      startReceipts: [{ state: 'failed', lastError: 'agent_prompt_stalled' }],
      screen: [
        'Quick safety check: Is this a project you created or one you trust?',
        '> 1. Yes, I trust this folder',
        '  2. No, exit'
      ]
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Trust prompt',
      builder: { agent: 'claude', model: 'sonnet' }
    })
    await settle(service, started.id)
    expect(service.show(started.id).builder).toMatchObject({
      startupBlocker: 'claude-folder-trust',
      terminalHandle: 'term_ctx_1'
    })
  })

  it('names a stalled start without guessing a prompt it cannot see', async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      startReceipts: [{ state: 'failed', lastError: 'agent_prompt_stalled' }],
      screen: ['Working on it']
    })
    const service = new BuildReviewService(runtime, caller)
    const started = service.start({
      worktree: 'id:x',
      objective: 'Stall',
      builder: { agent: 'claude', model: 'sonnet' }
    })
    await settle(service, started.id)
    expect(service.show(started.id).builder.startupBlocker).toBe('agent-prompt-stalled')
  })

  it('retries a failed run under the same id once its workspace is released', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      startReceipts: [{ state: 'failed', lastError: 'agent_prompt_stalled' }]
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({ worktree: 'id:repo::/wt', objective: 'Try again' })
    vi.mocked(releaseBuildReviewWorkspace).mockReturnValueOnce(false)
    reconcile.releaseSettled.mockImplementation(async (_deps, _key, mode) =>
      mode === 'observe' ? { reservation: { pipeline_id: id, run_id: 'run_1' } } : null
    )
    await finished(service, id)
    expect(service.show(id).workspaceHold).toEqual({ pipelineId: id, runId: 'run_1', items: [] })

    const retried = await service.retry(id)
    expect(retried).toMatchObject({ id, stage: 'starting', error: null, workspaceHold: null })
    expect(reconcile.releaseSettled).toHaveBeenLastCalledWith(
      expect.anything(),
      'local-workspace',
      'release'
    )
    await settle(service, id)
    const done = service.show(id)
    expect(done.stage).toBe('completed')
    expect(done.builder.dispatchId).toBe('ctx_2')
    expect(done.events.some((event) => event.text === 'Retry requested')).toBe(true)
    expect(calls.filter((call) => call.method === 'orchestration.runCreate')).toHaveLength(2)
  })

  it('lets only one of two concurrent Retries launch the run again', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({
      builderOutcome: 'succeeded',
      startReceipts: [{ state: 'failed', lastError: 'boom' }]
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({ worktree: 'id:repo::/wt', objective: 'Twice' })
    vi.mocked(releaseBuildReviewWorkspace).mockReturnValueOnce(false)
    reconcile.releaseSettled.mockImplementation(async (_deps, _key, mode) =>
      mode === 'observe' ? { reservation: { pipeline_id: id, run_id: 'run_1' } } : null
    )
    await finished(service, id)
    const results = await Promise.allSettled([service.retry(id), service.retry(id)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    await finished(service, id)
    expect(calls.filter((call) => call.method === 'orchestration.runCreate')).toHaveLength(2)
  })

  it('refuses Retry while the workspace is still held and says so on the run', async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({
      builderOutcome: 'succeeded',
      startReceipts: [{ state: 'failed', lastError: 'boom' }]
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({ worktree: 'id:repo::/wt', objective: 'Held' })
    vi.mocked(releaseBuildReviewWorkspace).mockReturnValueOnce(false)
    const held = { reservation: { pipeline_id: id, run_id: 'run_1' } }
    reconcile.releaseSettled.mockResolvedValue(held)
    await finished(service, id)
    await expect(service.retry(id)).rejects.toThrow(/still reserved/)
    expect(service.show(id).stage).toBe('failed')
    await expect(service.releaseWorkspace(id)).resolves.toMatchObject({
      workspaceHold: { pipelineId: id }
    })
    reconcile.releaseSettled.mockResolvedValue(null)
    await expect(service.releaseWorkspace(id)).resolves.toMatchObject({ workspaceHold: null })
    expect(service.show(id).events.some((event) => event.text === 'Workspace released')).toBe(true)
  })

  it('records which earlier run holds the workspace when the claim is refused', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    vi.mocked(claimBuildReviewWorkspace).mockImplementationOnce(() => {
      throw new BuildReviewWorkspaceHeldError(
        {
          workspace_key: 'local-workspace',
          pipeline_id: 'brp_earlier',
          runtime_epoch: 'runtime_1',
          owner_pid: 1,
          run_id: 'run_earlier',
          worker_start_in_flight: 0,
          worker_dispatch_ids: '[]'
        },
        [],
        false,
        false
      )
    })
    const service = new BuildReviewService(runtime, caller)
    const { id } = service.start({ worktree: 'id:repo::/wt', objective: 'Blocked' })
    await finished(service, id)
    const done = service.show(id)
    expect(done.stage).toBe('failed')
    expect(done.error).toContain('brp_earlier still owns this workspace')
    expect(done.workspaceHold).toEqual({
      pipelineId: 'brp_earlier',
      runId: 'run_earlier',
      items: []
    })
    expect(calls.some((call) => call.method === 'orchestration.workerStart')).toBe(false)
  })
})
