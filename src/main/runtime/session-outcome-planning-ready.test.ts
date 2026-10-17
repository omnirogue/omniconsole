import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeService } from './session-outcome-service'
import { preparePendingSessionOutcomeWorkflow } from './session-outcome-planning-ready'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'

const { assertSource, observe, capture, prepare } = vi.hoisted(() => ({
  assertSource: vi.fn(),
  observe: vi.fn(),
  capture: vi.fn(),
  prepare: vi.fn()
}))
vi.mock('./session-outcome-workflow-source', () => ({
  assertSessionOutcomePlanningSource: assertSource
}))
vi.mock('./session-outcome-source', () => ({ observeSessionOutcomeSource: observe }))
vi.mock('./session-outcome-initial-source', () => ({ captureInitialSessionOutcomeSource: capture }))
vi.mock('./session-outcome-workflow-prepare', () => ({ prepareSessionOutcomeWorkflow: prepare }))

beforeEach(() => {
  assertSource.mockReset()
  observe.mockReset().mockResolvedValue({ ready: true, version: 'actual-completed-turn' })
  capture.mockReset()
  prepare.mockReset()
})

function fixture() {
  const initialSource = {
    sourceVersion: 'actual-completed-turn',
    paneKey: 'source',
    worktreeId: 'tree',
    handle: 'agent-session:original',
    processIncarnation: 'structured:original',
    producer: { provider: 'codex', model: 'gpt-6-astra' },
    files: [
      {
        rel: 'uploads/result.md',
        name: 'result.md',
        sha256: 'a'.repeat(64),
        size_bytes: 24,
        target_path: 'result.md'
      }
    ]
  }
  const chain = {
    id: 'chain',
    worktreeId: 'tree',
    sourcePaneKey: 'source',
    steps: [],
    outcomeSet: {
      revision: 4,
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        state: 'owned',
        taskId: 'btk_actual',
        principal: 'signed-person',
        planningSource: {
          runId: 'run_pristine',
          projectionTaskId: 'task_pristine',
          coordinatorHandle: initialSource.handle,
          processIncarnation: initialSource.processIncarnation
        }
      },
      outcomes: [
        { id: 'review', status: 'pending' },
        { id: 'finished', status: 'satisfied', evidence: [{ id: 'existing-proof' }] }
      ]
    }
  } as unknown as SessionChain
  const runtime = {} as OrcaRuntimeService
  let current = chain
  const saved: SessionChain[] = []
  const save = vi.fn((next: SessionChain, revision: number) => {
    expect(revision).toBe(current.outcomeSet!.revision)
    saved.push(next)
    current = next
    return next
  })
  const service = { runtime, save } as unknown as SessionOutcomeService
  capture.mockImplementation(async (_runtime, input: SessionChain) => ({
    ...input,
    outcomeSet: {
      ...input.outcomeSet!,
      continuation: { ...input.outcomeSet!.continuation, initialSource }
    }
  }))
  const { workflow } = workflowProofFixture()
  prepare.mockImplementation(async (_runtime, input: SessionChain) => ({
    ...input,
    outcomeSet: { ...input.outcomeSet!, workflow: { ...workflow, phase: 'prepared' } }
  }))
  return { chain, runtime, service, save, saved, initialSource, current: () => current }
}

it.each([
  [{ ready: false }, 'source session'],
  [
    { ready: false, wait: { code: 'source-turn', wake: 'this conversation to finish its turn' } },
    'this conversation to finish its turn'
  ]
])(
  'waits, and says so, while its actual source is still running: %j',
  async (observation, wake) => {
    const f = fixture()
    observe.mockResolvedValueOnce(observation)
    await expect(
      preparePendingSessionOutcomeWorkflow(f.service, f.chain, 7)
    ).resolves.toBeUndefined()
    expect(assertSource).toHaveBeenCalledWith(f.runtime, f.chain)
    expect(observe).toHaveBeenCalledWith(f.runtime, f.chain, { successfulOnly: true })
    expect(f.current().outcomeSet!.continuation).toMatchObject({
      sourceReady: false,
      state: 'owned'
    })
    expect(f.current().outcomeSet!.continuation.sourceVersion).toBeUndefined()
    // A source that gives no reason is still a registered wake, never a silent pending run.
    expect(f.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'The source session has not finished its turn yet.',
      block: { class: 'waiting', code: 'source-turn', wake, since: 7 }
    })
    expect(f.current().outcomeSet!.outcomes[1]).toEqual(f.chain.outcomeSet!.outcomes[1])
    expect(capture).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  }
)

it('persists the completed source snapshot before asking for a workflow preview', async () => {
  const f = fixture()
  const preview = prepare.getMockImplementation()!
  prepare.mockImplementationOnce(async (runtime, chain: SessionChain) => {
    expect(f.current().outcomeSet!.continuation.initialSource).toBe(
      chain.outcomeSet!.continuation.initialSource
    )
    expect(f.current().outcomeSet!.continuation).toMatchObject({
      sourceReady: true,
      sourceVersion: 'actual-completed-turn',
      initialSource: f.initialSource
    })
    expect(f.current().outcomeSet!.workflow).toBeUndefined()
    return preview(runtime, chain)
  })
  const prepared = await preparePendingSessionOutcomeWorkflow(f.service, f.chain)
  expect(prepared).toBe(f.current())
  expect(capture).toHaveBeenCalledWith(
    f.runtime,
    expect.objectContaining({
      outcomeSet: expect.objectContaining({
        continuation: expect.objectContaining({
          sourceReady: true,
          sourceVersion: 'actual-completed-turn'
        })
      })
    })
  )
  expect(f.current().outcomeSet!.workflow?.phase).toBe('prepared')
  expect(f.current().outcomeSet!.continuation.initialSource).toEqual(f.initialSource)
  expect(f.current().outcomeSet!.outcomes[1]).toEqual(f.chain.outcomeSet!.outcomes[1])
})

it('retains the exact source snapshot across a failed preview and retries without recapturing', async () => {
  const f = fixture()
  prepare.mockRejectedValueOnce(new Error('Preview service unavailable'))
  await expect(preparePendingSessionOutcomeWorkflow(f.service, f.chain)).resolves.toBeUndefined()
  const retained = f.current().outcomeSet!.continuation.initialSource
  expect(retained).toEqual(f.initialSource)
  expect(f.current().outcomeSet!.outcomes[0]).toMatchObject({
    status: 'blocked',
    blockedReason: 'Preview service unavailable'
  })
  expect(f.current().outcomeSet!.workflow).toBeUndefined()
  capture.mockClear()
  observe.mockClear().mockResolvedValue({ ready: false })
  await preparePendingSessionOutcomeWorkflow(f.service, f.current())
  expect(capture).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
  expect(f.current().outcomeSet!.continuation.initialSource).toBe(retained)
  expect(f.current().outcomeSet!.workflow?.phase).toBe('prepared')
  expect(f.current().outcomeSet!.outcomes[0]).toMatchObject({
    status: 'pending',
    blockedReason: undefined
  })
})

it.each([
  { ready: false, unverifiable: true, reason: 'Source host is unavailable.' },
  { ready: false, reason: 'The source did not finish successfully.' }
])(
  'blocks without capture or preview when successful completion is unavailable: %j',
  async (observation) => {
    const f = fixture()
    observe.mockResolvedValueOnce(observation)
    await preparePendingSessionOutcomeWorkflow(f.service, f.chain)
    expect(f.current().outcomeSet!.continuation).toMatchObject({
      sourceReady: false,
      state: observation.unverifiable ? 'unverifiable' : 'owned'
    })
    expect(f.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: observation.reason
    })
    expect(f.current().outcomeSet!.outcomes[1]).toEqual(f.chain.outcomeSet!.outcomes[1])
    expect(capture).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  }
)

it.each([
  'The completed source agent identity or actual model could not be verified on its host.',
  'The source changed while its result was being captured.'
])(
  'keeps capture verification failures blocked without admitting a preview: %s',
  async (reason) => {
    const f = fixture()
    capture.mockRejectedValueOnce(new Error(reason))
    await preparePendingSessionOutcomeWorkflow(f.service, f.chain)
    expect(f.current().outcomeSet!.continuation.initialSource).toBeUndefined()
    expect(f.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: reason
    })
    expect(prepare).not.toHaveBeenCalled()
  }
)

it('refuses a replaced pristine coordinator before checking completion', async () => {
  const f = fixture()
  assertSource.mockImplementationOnce(() => {
    throw new Error('The pristine coordinator changed.')
  })
  await preparePendingSessionOutcomeWorkflow(f.service, f.chain)
  expect(f.current().outcomeSet!.outcomes[0]).toMatchObject({
    status: 'blocked',
    blockedReason: 'The pristine coordinator changed.'
  })
  expect(observe).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})
