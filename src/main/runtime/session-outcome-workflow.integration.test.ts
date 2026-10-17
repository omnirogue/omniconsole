import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as reviewReadback from '../console-workflows/console-github-review-readback'
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import {
  sessionOutcomeWorkflowFixture as fixture,
  workflowDefinition as definition,
  workflowFixtures as fixtures
} from './session-outcome-workflow-test-fixture'

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

it('saves the full reviewed graph before admission or activation and never completes the original projection', async () => {
  const { f, chain, port, created } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  const saved = f.service.get(chain.id).outcomeSet!
  expect(saved.workflow).toBeUndefined()
  const durable = JSON.parse(readFileSync(join(f.workspace, '.omni', 'state.json'), 'utf8'))
  expect(durable.sessionChains[0].outcomeSet).toEqual(saved)
  expect(port.captureSourceInputs).not.toHaveBeenCalled()
  expect(port.preview).not.toHaveBeenCalled()
  expect(port.admit).not.toHaveBeenCalled()
  expect(port.start).not.toHaveBeenCalled()
  await f.service.tick()
  expect(port.captureSourceInputs).toHaveBeenCalledOnce()
  expect(port.preview).toHaveBeenCalledOnce()
  expect(port.admit).toHaveBeenCalledOnce()
  expect(port.start).toHaveBeenCalledOnce()
  expect(f.service.get(chain.id).outcomeSet!.continuation.planningSource?.runId).toBe(
    created.run.id
  )
  expect(f.db.getTask(created.projectionTaskId)).toMatchObject({
    hub_task_id: 'btk_nativeoutcomes',
    spec: 'btk_nativeoutcomes',
    status: 'ready'
  })
  expect(f.launched).toEqual([])
})

it('saves a first review while its source is working, then captures the completed source before starting review once', async () => {
  const { f, chain, port, sourceContext, jobs } = await fixture()
  const hook = vi.mocked(f.runtime.getFreshAgentHookStatusForHandle)
  const working = {
    state: 'working' as const,
    lastAssistantMessage: null,
    interactivePrompt: null,
    stateStartedAt: 100,
    updatedAt: 100
  }
  hook.mockReturnValue(working)
  chain.steps = [
    {
      id: 'review-source',
      agent: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      prompt: 'Review the completed analysis and source-report.md.',
      status: 'queued',
      review: {
        groupId: 'source-review',
        reviewerId: 'astra',
        round: 1,
        maxRounds: 1,
        candidateVersion: 'pending'
      }
    }
  ]
  await f.service.commit(chain, {
    expectedRevision: 0,
    source: 'user',
    outcomes: [{ ...definition, stepIds: ['review-source'] }]
  })
  f.service.dispose()
  expect(f.service.get(chain.id).steps).toMatchObject([{ id: 'review-source' }])
  expect(f.service.get(chain.id).outcomeSet!.workflow).toBeUndefined()
  await f.service.tick()
  await f.service.tick()
  expect(sourceContext).not.toHaveBeenCalled()
  expect(port.captureSourceInputs).not.toHaveBeenCalled()
  expect(port.preview).not.toHaveBeenCalled()
  expect(port.admit).not.toHaveBeenCalled()
  expect(port.start).not.toHaveBeenCalled()

  f.write('source-report.md', 'Final source analysis.\n')
  const summary = 'The source completed its analysis and wrote source-report.md.'
  hook.mockReturnValue({
    ...working,
    state: 'done',
    stateStartedAt: 200,
    updatedAt: 200,
    lastAssistantMessage: summary
  })
  await f.service.tick()
  expect(sourceContext).toHaveBeenCalledExactlyOnceWith('source', 'folder:outcome')
  expect(port.captureSourceInputs).toHaveBeenCalledExactlyOnceWith(f.runtime, {
    taskId: 'btk_nativeoutcomes',
    principal: 'person',
    worktree: 'id:folder:outcome',
    selectedSourcePaths: ['source-report.md'],
    sourceResult: { path: expect.stringMatching(/\/source-result\.md$/), content: summary }
  })
  expect(port.preview).toHaveBeenCalledOnce()
  const request = vi.mocked(port.preview).mock.calls[0]![1]
  expect(request.stages[0]!.loop).toMatchObject({
    participants: ['codex:gpt-5.6-terra', 'codex:gpt-6-astra'],
    max_rounds: 1
  })
  expect(request.currentInputs).toMatchObject([
    {
      mode: 'review-source',
      producer: { provider: 'codex', model: 'gpt-5.6-terra' },
      files: [{ target_path: 'source-report.md' }, { name: 'source-result.md' }]
    }
  ])
  const captured = f.service.get(chain.id).outcomeSet!.continuation.initialSource!
  expect(captured).toMatchObject({
    paneKey: 'source',
    handle: 'source',
    processIncarnation: 'test:source:1',
    producer: { provider: 'codex', model: 'gpt-5.6-terra' },
    effort: 'high',
    files: request.currentInputs![0]!.files
  })
  expect(port.admit).toHaveBeenCalledOnce()
  expect(port.start).toHaveBeenCalledOnce()
  expect(jobs()).toMatchObject([
    { model: 'gpt-6-astra', policy: { workflow: { action: 'review' } } }
  ])
  expect(jobs()).toHaveLength(1)
  await f.service.tick()
  expect(port.captureSourceInputs).toHaveBeenCalledOnce()
  expect(port.start).toHaveBeenCalledOnce()
})

it('pins an omitted model before admission and preserves the saved selection on later edits', async () => {
  const { f, chain, port } = await fixture()
  const model = {
    id: 'gpt-5.6-terra',
    label: 'Terra',
    isDefault: true,
    thinkingLevels: [{ id: 'high', label: 'High' }]
  }
  const probe = vi.spyOn(f.runtime, 'discoverRuntimeCommitMessageModels').mockResolvedValue({
    success: true,
    capability: {
      id: 'codex',
      label: 'Codex',
      modelSource: 'dynamic',
      models: [model],
      defaultModelId: model.id
    },
    models: [model],
    defaultModelId: model.id,
    catalogOrigin: 'probe'
  })
  const producer = chain.steps[0]!
  if (producer.kind === 'handoff') {
    throw new Error('Expected an agent producer')
  }
  delete producer.model
  const saved = await f.service.commit(chain, {
    expectedRevision: 0,
    source: 'user',
    outcomes: [definition]
  })
  f.service.dispose()
  expect(probe).toHaveBeenCalledWith('id:folder:outcome', 'codex')
  expect(saved.steps[0]).toMatchObject({ model: model.id, effort: 'high' })
  expect(f.service.get(chain.id).steps[0]).toMatchObject({ model: model.id })
  // The save pins the model; #284 (720690b3e) admits the plan only on the tick that captures its
  // completed source, so this is where the pinned actor must reach the reviewed graph.
  await f.service.tick()
  expect(vi.mocked(port.preview).mock.calls[0]![1].stages[0]).toMatchObject({
    actor: `codex:${model.id}`,
    effort: 'high'
  })
  probe.mockRejectedValue(new Error('A saved explicit model must not be rediscovered'))
  await f.service.commit(saved, {
    // The admitting tick saved its own generation, so the later edit carries that revision.
    expectedRevision: f.service.get(chain.id).outcomeSet!.revision,
    source: 'user',
    outcomes: [definition]
  })
  f.service.dispose()
  expect(probe).toHaveBeenCalledOnce()
  expect(port.preview).toHaveBeenCalledOnce()
})

it('does not repeat an ambiguous activation across polls or a reopened persisted state', async () => {
  const { f, chain, port } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  await f.service.tick()
  await f.service.tick()
  const saved = f.service.get(chain.id)
  expect(saved.outcomeSet!.workflow!.activations).toMatchObject([{ state: 'unverifiable' }])
  expect(port.start).toHaveBeenCalledOnce()
  await f.service.suspend()
  f.closeDatabase()
  const reopened = outcomeRuntimeFixture(() => ({ body: 'must not run' }), f.workspace)
  fixtures.push(reopened)
  await reopened.service.tick()
  reopened.service.dispose()
  expect(reopened.service.get(chain.id).outcomeSet!.workflow!.activations).toEqual(
    saved.outcomeSet!.workflow!.activations
  )
  expect(port.start).toHaveBeenCalledOnce()
})

it('saves changed work before cancellation, retires the old queued graph, then admits only the replacement', async () => {
  const { f, chain, port, jobs } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  await f.service.tick()
  const saved = f.service.get(chain.id),
    oldWorkflow = structuredClone(saved.outcomeSet!.workflow!),
    oldJob = jobs()[0]!
  const cancel = vi.fn(async () => {
    expect(f.service.get(chain.id).outcomeSet!.amendment!.jobs[0]!.state).toBe('requested')
    expect(port.admit).toHaveBeenCalledOnce()
    oldJob.status = 'cancelled'
  })
  vi.mocked(port.cancellation).mockReturnValue({
    now: () => 1,
    cancelQueued: cancel,
    cancelRunning: vi.fn(),
    readJob: async () => ({
      jobId: oldJob.id,
      workflowId: oldWorkflow.preview.workflow_id,
      approvedDigest: oldWorkflow.preview.digest,
      taskId: oldJob.task_id,
      attempt: null,
      leaseGeneration: null,
      state: oldJob.status === 'cancelled' ? 'cancelled' : 'queued',
      serverCancellationAcknowledged: oldJob.status === 'cancelled',
      terminalStopped: true,
      acceptedCompletion: null
    })
  })
  const committed = await f.service.commit(
    { ...saved, steps: [{ ...saved.steps[0]!, prompt: 'Write the revised requested report' }] },
    { expectedRevision: saved.outcomeSet!.revision, source: 'user', outcomes: [definition] }
  )
  f.service.dispose()
  expect(cancel).not.toHaveBeenCalled()
  expect(committed.outcomeSet!.workflowHistory).toEqual([oldWorkflow])
  expect(committed.steps[0]!.id).not.toBe(saved.steps[0]!.id)
  expect(committed.outcomeSet!.amendment!.state).toBe('prepared')
  await f.service.tick()
  expect(cancel).toHaveBeenCalledOnce()
  expect(port.admit).toHaveBeenCalledTimes(2)
  expect(f.service.get(chain.id).outcomeSet!.workflowHistory![0]).toMatchObject({
    retired: true,
    preview: oldWorkflow.preview
  })
  await f.service.tick()
  expect(cancel).toHaveBeenCalledOnce()
  expect(port.start).toHaveBeenCalledTimes(2)
  const beforeAuditError = structuredClone(f.service.get(chain.id).outcomeSet!.outcomes)
  const observe = vi.mocked(port.observe).getMockImplementation()!
  vi.mocked(port.observe).mockImplementation((workflowId, principal) =>
    workflowId === oldWorkflow.preview.workflow_id
      ? Promise.resolve({
          ok: false,
          error: { code: 'audit-unavailable', message: 'Retired audit readback unavailable' }
        })
      : observe(workflowId, principal)
  )
  await f.service.tick()
  expect(f.service.get(chain.id).outcomeSet!.workflowHistory![0]!.error).toBe(
    'Retired audit readback unavailable'
  )
  expect(f.service.get(chain.id).outcomeSet!.outcomes).toEqual(beforeAuditError)
  expect(port.start).toHaveBeenCalledTimes(2)
})

it('retains a blocked amendment across restart without admitting replacement work', async () => {
  const { f, chain, port } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  await f.service.tick()
  const old = f.service.get(chain.id)
  await f.service.commit(
    { ...old, steps: [{ ...old.steps[0]!, prompt: 'Revised deliverable' }] },
    { expectedRevision: old.outcomeSet!.revision, source: 'user', outcomes: [definition] }
  )
  f.service.dispose()
  await f.service.tick()
  const saved = f.service.get(chain.id)
  expect(saved.outcomeSet!.amendment!.state).toBe('prepared')
  expect(port.admit).toHaveBeenCalledOnce()
  await f.service.suspend()
  f.closeDatabase()
  const reopened = outcomeRuntimeFixture(() => ({ body: 'must not start' }), f.workspace)
  fixtures.push(reopened)
  await reopened.service.tick()
  reopened.service.dispose()
  expect(port.admit).toHaveBeenCalledOnce()
  expect(reopened.service.get(chain.id).outcomeSet!.amendment).toEqual(saved.outcomeSet!.amendment)
})

it('cannot admit or activate when durable Save fails', async () => {
  const { f, chain, port } = await fixture()
  vi.mocked(f.runtime.replaceSessionChainOutcomesAndFlush).mockImplementation(() => {
    throw new Error('Disk commit failed')
  })
  await expect(
    f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  ).rejects.toThrow('Disk commit failed')
  f.service.dispose()
  await f.service.tick()
  expect(port.admit).not.toHaveBeenCalled()
  expect(port.start).not.toHaveBeenCalled()
})

it('adds an independent outcome as a new admitted generation without replacing the prior graph or repeating its worker', async () => {
  const { f, chain, port } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  await f.service.tick()
  const saved = f.service.get(chain.id)
  const prior = structuredClone(saved.outcomeSet!.workflow!)
  const next = {
    ...definition,
    id: 'additional',
    title: 'Additional requested file',
    stepIds: ['extra']
  }
  const committed = await f.service.commit(
    {
      ...saved,
      steps: [...saved.steps, { ...saved.steps[0]!, id: 'extra' }]
    },
    { expectedRevision: saved.outcomeSet!.revision, source: 'user', outcomes: [definition, next] }
  )
  f.service.dispose()
  expect(committed.outcomeSet!.workflowHistory).toEqual([prior])
  expect(committed.outcomeSet!.workflow!.stages.flatMap((stage) => stage.stepIds)).toEqual([
    'extra'
  ])
  await f.service.tick()
  expect(port.preview).toHaveBeenCalledTimes(2)
  expect(port.start).toHaveBeenCalledTimes(2)
  expect(f.service.get(chain.id).outcomeSet!.workflowHistory![0]!.activations).toEqual(
    prior.activations
  )
})

it('preserves independently satisfied file evidence when cancellation of an edited stage fails', async () => {
  const { f, chain, port } = await fixture()
  f.write('external.txt', 'The independently requested external artifact.\n')
  const external: SessionOutcomeDefinition = {
    id: 'external',
    title: 'Verify the existing external artifact',
    finish: 'complete',
    dependsOn: [],
    stepIds: [],
    conditions: [{ id: 'external-file', kind: 'file', target: 'external.txt' }],
    actions: []
  }
  await f.service.commit(chain, {
    expectedRevision: 0,
    source: 'user',
    outcomes: [definition, external]
  })
  f.service.dispose()
  await f.service.tick()
  const before = f.service.get(chain.id)
  const completed = structuredClone(
    before.outcomeSet!.outcomes.find((outcome) => outcome.id === external.id)!
  )
  expect(completed.status).toBe('satisfied')
  expect(completed.evidence.some((evidence) => evidence.verifiedAt > 0)).toBe(true)
  const changed = {
    ...before,
    steps: [{ ...before.steps[0]!, prompt: 'Write a revised requested report.' }]
  }
  await f.service.commit(changed, {
    expectedRevision: before.outcomeSet!.revision,
    source: 'user',
    outcomes: [definition, external]
  })
  f.service.dispose()
  await f.service.tick()
  const after = f.service.get(chain.id)
  expect(after.outcomeSet!.outcomes.find((outcome) => outcome.id === external.id)).toEqual(
    completed
  )
  expect(after.outcomeSet!.outcomes.find((outcome) => outcome.id === definition.id)).toMatchObject({
    status: 'blocked',
    blockedReason: 'No cancellation fixture installed'
  })
  expect(port.admit).toHaveBeenCalledOnce()
  await expect(
    f.service.commit(
      { ...after, steps: [{ ...after.steps[0]!, prompt: 'Another edit' }] },
      {
        expectedRevision: after.outcomeSet!.revision,
        source: 'user',
        outcomes: [{ ...definition, stepIds: [after.steps[0]!.id] }, external]
      }
    )
  ).rejects.toThrow('previous saved amendment must finish cancellation')
})

it('holds replacement admission and cancellation until an older merge request is reconciled', async () => {
  const { f, chain, port } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  await f.service.tick()
  const prior = f.service.get(chain.id)
  await f.service.commit(
    { ...prior, steps: [{ ...prior.steps[0]!, prompt: 'Amended work after publication' }] },
    {
      expectedRevision: prior.outcomeSet!.revision,
      source: 'user',
      outcomes: [definition]
    }
  )
  f.service.dispose()
  const edited = f.service.get(chain.id),
    head = 'a'.repeat(40)
  const admission = {
    provider: 'github' as const,
    producerGitSha: head,
    acceptedReviews: [
      {
        artifactId: 'retained-result',
        artifactVersion: 'retained-fingerprint',
        reviewerId: 'reviewer',
        verdict: 'accepted' as const,
        producerGitSha: head,
        repo: 'Example/project',
        prNumber: 1,
        headRef: 'omni/job_original',
        baseRef: 'main',
        headSha: head
      }
    ],
    review: {
      repo: 'Example/project',
      prNumber: 1,
      url: 'https://github.com/Example/project/pull/1',
      state: 'open' as const,
      headRef: 'omni/job_original',
      baseRef: 'main',
      headSha: head,
      mergeCommitSha: null
    }
  }
  f.service.save(
    {
      ...edited,
      outcomeSet: {
        ...edited.outcomeSet!,
        publications: [
          {
            id: 'prior-merge',
            outcomeId: 'build',
            conditionId: 'merge',
            state: 'requested',
            admission
          }
        ]
      }
    },
    edited.outcomeSet!.revision
  )
  const read = vi
    .spyOn(reviewReadback, 'readMergedGitHubReview')
    .mockRejectedValue(new reviewReadback.GitHubReviewReadbackError('not-merged', 'Still pending'))
  try {
    await f.service.tick()
    expect(port.admit).toHaveBeenCalledOnce()
    expect(port.cancellation).not.toHaveBeenCalled()
    expect(f.service.get(chain.id).outcomeSet!.publications![0]!.state).toBe('requested')
    read.mockResolvedValue({
      ...admission,
      review: { ...admission.review, state: 'merged', mergeCommitSha: 'b'.repeat(40) }
    })
    vi.mocked(port.cancellation).mockImplementation(() => {
      expect(f.service.get(chain.id).outcomeSet!.publications![0]!.state).toBe('merged')
      throw new Error('Cancellation fixture remains blocked')
    })
    await f.service.tick()
    expect(port.cancellation).toHaveBeenCalledOnce()
    expect(port.admit).toHaveBeenCalledOnce()
  } finally {
    read.mockRestore()
  }
})

it('clears current producer proof on a failed readback while retaining the immutable result receipt', async () => {
  const { f, chain, port, jobs } = await fixture()
  await f.service.commit(chain, { expectedRevision: 0, source: 'user', outcomes: [definition] })
  f.service.dispose()
  await f.service.tick()
  const prior = f.service.get(chain.id)
  const receipt = {
    ...workflowProofFixture().workflow.receipts![0]!,
    jobId: jobs()[0]!.id,
    taskId: jobs()[0]!.task_id,
    key: jobs()[0]!.policy.workflow.key
  }
  f.service.save(
    {
      ...prior,
      outcomeSet: {
        ...prior.outcomeSet!,
        workflow: {
          ...prior.outcomeSet!.workflow!,
          receipts: [receipt],
          verifiedProducerReceipts: [receipt]
        }
      }
    },
    prior.outcomeSet!.revision
  )
  vi.mocked(port.observe).mockResolvedValue({
    ok: false,
    error: { code: 'unavailable', message: 'Current canonical proof unavailable' }
  })
  await f.service.tick()
  expect(f.service.get(chain.id).outcomeSet!.workflow).toMatchObject({
    receipts: [receipt],
    verifiedProducerReceipts: [],
    error: 'Current canonical proof unavailable'
  })
  expect(port.start).toHaveBeenCalledOnce()
})
