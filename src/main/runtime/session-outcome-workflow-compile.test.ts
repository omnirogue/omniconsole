import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { folderRoundFixture } from './session-outcome-workflow-folder-round-fixture'
import { expect, it, vi } from 'vitest'
import { compileSessionOutcomeWorkflow } from './session-outcome-workflow-compile'
import { prepareSessionOutcomeWorkflow } from './session-outcome-workflow-prepare'
import {
  installSessionOutcomeWorkflowPort,
  type SessionOutcomeWorkflowPort
} from './session-outcome-workflow-port'
import type { SessionChain } from '../../shared/session-chain-types'
import type { ConsoleWorkflowNode } from '../../shared/console-workflow-types'
import type { OrcaRuntimeService } from './omni-runtime'

function chain(): SessionChain {
  const review = {
    groupId: 'independent-review',
    round: 1,
    maxRounds: 1,
    candidateVersion: 'saved-original',
    adversarial: true
  }
  return {
    id: 'chain',
    workspacePath: '/repo',
    worktreeId: 'tree',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'source',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'producer',
        agent: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'high',
        prompt: 'Create the exact file and PR.',
        status: 'queued'
      },
      {
        id: 'astra',
        agent: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        prompt: 'Attack inputs and file boundaries.',
        review: { ...review, reviewerId: 'astra' },
        status: 'queued'
      },
      {
        id: 'sol',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        prompt: 'Attack restart and idempotency.',
        review: { ...review, reviewerId: 'sol' },
        status: 'queued'
      }
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'deliver',
          title: 'Deliver exact reviewed file',
          finish: 'my-review',
          dependsOn: [],
          stepIds: ['producer', 'astra', 'sol'],
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: '/chosen/report.md' }],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ]
    }
  }
}
/** #284 (720690b3e) requires an authorized repair owner before more than one review round. */
function reviewRepairStep(model: string, effort: string): SessionChain['steps'][number] {
  return {
    id: 'repair',
    agent: 'codex',
    model,
    effort,
    status: 'queued',
    prompt: 'Fix the review findings.',
    reviewRepair: {
      groupId: 'independent-review',
      afterRound: 1,
      candidateVersion: 'saved-original',
      consumptionKey: 'repair-round-1'
    }
  }
}
it('freezes exact producer, independent reviewers, bounded repair and all original obligations into one canonical loop', () => {
  const result = compileSessionOutcomeWorkflow(chain())
  expect(result.stages).toHaveLength(1)
  expect(result.stages[0]!.loop).toEqual({
    kind: 'adversarial',
    participants: ['codex:gpt-5.6-terra', 'codex:gpt-6-astra', 'codex:gpt-5.6-sol'],
    max_rounds: 1,
    stop_rule: 'zero_blockers'
  })
  for (const instruction of chain().steps.map((step) =>
    step.kind === 'handoff' ? '' : step.prompt
  )) {
    expect(result.stages[0]!.prompt).toContain(instruction)
  }
  expect(result.stages[0]!.prompt).toContain('/chosen/report.md')
  expect(result.bindings[0]!.stepIds).toEqual(['producer', 'astra', 'sol'])
})
it('preserves independent participant efforts in the canonical loop', () => {
  const changed = chain()
  if (changed.steps[1]!.kind !== 'handoff') {
    changed.steps[1]!.effort = 'low'
  }
  expect(compileSessionOutcomeWorkflow(changed).stages[0]!.loop!.participant_efforts).toEqual({
    'codex:gpt-5.6-terra': 'high',
    'codex:gpt-6-astra': 'low',
    'codex:gpt-5.6-sol': 'high'
  })
})
it('keeps independent outcomes as separate roots instead of scheduling them behind unrelated work', () => {
  const changed = chain()
  changed.steps = [changed.steps[0]!, { ...changed.steps[0]!, id: 'independent' }]
  changed.outcomeSet!.outcomes[0]!.stepIds = ['producer']
  changed.outcomeSet!.outcomes.push({
    ...changed.outcomeSet!.outcomes[0]!,
    id: 'other',
    stepIds: ['independent']
  })
  const result = compileSessionOutcomeWorkflow(changed)
  expect(result.stages.map((stage) => stage.after)).toEqual([[], []])
})

it('uses explicit review-source mode to preserve an accepted producer while adding bounded independent reviews', () => {
  const value = chain(),
    receipt = workflowProofFixture().workflow.receipts![0]!
  value.steps = value.steps.slice(1)
  value.outcomeSet!.outcomes[0]!.stepIds = ['astra', 'sol']
  const result = compileSessionOutcomeWorkflow(
    value,
    new Map([['astra', { receipt, effort: 'high' }]])
  )
  expect(result.bindings[0]!.stepIds).toEqual(['astra', 'sol'])
  expect(result.predecessorReceipts).toEqual([
    {
      stage_key: result.stages[0]!.key,
      job_id: receipt.jobId,
      receipt_event_id: receipt.eventId,
      fingerprint: receipt.fingerprint,
      mode: 'review-source'
    }
  ])
  expect(result.stages[0]!.loop!.participants).toEqual([
    'codex:gpt-5.6-terra',
    'codex:gpt-6-astra',
    'codex:gpt-5.6-sol'
  ])
})
it('uses base mode for changed implementation so a prior result cannot suppress its new producer', () => {
  const value = chain(),
    receipt = workflowProofFixture().workflow.receipts![0]!
  const result = compileSessionOutcomeWorkflow(
    value,
    new Map([['producer', { receipt, effort: 'high' }]])
  )
  expect(result.predecessorReceipts[0]!.mode).toBe('base')
  expect(result.bindings[0]!.stepIds).toContain('producer')
  expect(result.stages[0]!.prompt).toContain('Create the exact file and PR.')
})

it('admits an initial review from captured source bytes without fabricating a producer execution receipt', () => {
  const value = chain()
  value.steps = value.steps.slice(1)
  value.outcomeSet!.outcomes[0]!.stepIds = ['astra', 'sol']
  const files = [
    {
      rel: 'uploads/source.md',
      name: 'source.md',
      sha256: 'c'.repeat(64),
      size_bytes: 12,
      target_path: 'source.md'
    }
  ]
  const producer = { provider: 'claude', model: 'claude-source' }
  const git = { head_sha: 'd'.repeat(40), deleted_paths: ['old.md'] }
  const result = compileSessionOutcomeWorkflow(
    value,
    new Map(),
    new Map([['astra', { ...producer, producer, files, git }]])
  )
  expect(result.stages[0]!.actor).toBe('claude:claude-source')
  expect(result.bindings[0]!.stepIds).toEqual(['astra', 'sol'])
  expect(result.predecessorReceipts).toEqual([])
  expect(result.currentInputs).toEqual([
    { stage_key: result.stages[0]!.key, mode: 'review-source', producer, files, git }
  ])
})

it('preserves the actual source separately from a different selected repair actor and equal-route reviewer', () => {
  const value = chain()
  value.steps = value.steps
    .slice(1)
    .map((entry) =>
      entry.kind === 'handoff' ? entry : { ...entry, review: { ...entry.review!, maxRounds: 2 } }
    )
  value.steps.push({
    id: 'repair',
    agent: 'claude',
    model: 'claude-repair',
    effort: 'low',
    status: 'queued',
    prompt: 'Fix the review findings.',
    reviewRepair: {
      groupId: 'independent-review',
      afterRound: 1,
      candidateVersion: 'saved-original',
      consumptionKey: 'repair-round-1'
    }
  })
  value.outcomeSet!.outcomes[0]!.stepIds = value.steps.map((entry) => entry.id)
  const producer = { provider: 'codex', model: 'gpt-6-astra' }
  const result = compileSessionOutcomeWorkflow(
    value,
    new Map(),
    new Map([['astra', { ...producer, producer, files: [] }]])
  )
  expect(result.stages[0]!.actor).toBe('claude:claude-repair')
  expect(result.stages[0]!.loop!.participants).toEqual([
    'claude:claude-repair',
    'codex:gpt-6-astra',
    'codex:gpt-5.6-sol'
  ])
  expect(result.stages[0]!.loop!.participant_ids).toHaveLength(3)
  expect(new Set(result.stages[0]!.loop!.participant_ids).size).toBe(3)
  expect(result.currentInputs[0]!.producer).toEqual(producer)
})

it('refuses implicit multi-round repair authority for a review-only request', () => {
  const value = chain()
  for (const step of value.steps) {
    if (step.kind !== 'handoff' && step.review) {
      step.review.maxRounds = 3
    }
  }
  expect(() => compileSessionOutcomeWorkflow(value)).toThrow('authorized repair step')
})

it('keeps implementation and exact reviewers as admitted stages when their outcome finishes with merge', () => {
  const plan = chain()
  plan.outcomeSet!.outcomes[0]!.finish = 'merge'
  plan.outcomeSet!.outcomes[0]!.conditions.push({
    id: 'merge',
    kind: 'merge',
    target: 'Reviewed PR',
    targetBranch: 'main'
  })
  const compiled = compileSessionOutcomeWorkflow(plan)
  expect(compiled.stages).toHaveLength(1)
  expect(compiled.bindings[0]!.stepIds).toEqual(['producer', 'astra', 'sol'])
  expect(compiled.stages[0]!.loop!.participants).toEqual([
    'codex:gpt-5.6-terra',
    'codex:gpt-6-astra',
    'codex:gpt-5.6-sol'
  ])
})
it('never turns an authored agent action into a fabricated host merge completion', () => {
  const plan = chain()
  plan.outcomeSet!.outcomes[0]!.finish = 'merge'
  plan.outcomeSet!.outcomes[0]!.actions = [
    {
      id: 'audit',
      instruction: 'Write the actual chosen audit file.',
      conditionIds: ['file'],
      authority: 'existing-user-authority',
      agent: 'codex',
      model: 'gpt-5.6-terra'
    }
  ]
  const compiled = compileSessionOutcomeWorkflow(plan)
  expect(compiled.stages).toHaveLength(2)
  expect(compiled.bindings[1]!.actionIds).toEqual(['audit'])
  expect(compiled.stages[1]!.prompt).toContain('Write the actual chosen audit file.')
})

it('authors review-current from explicit selected file pins without pretending an accepted Git source', () => {
  const plan = chain()
  plan.steps = plan.steps
    .slice(1)
    .map((step) =>
      step.kind === 'handoff' ? step : { ...step, review: { ...step.review!, maxRounds: 1 } }
    )
  plan.outcomeSet!.outcomes[0]!.stepIds = ['astra', 'sol']
  const source = {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    effort: 'high',
    files: [
      {
        rel: 'uploads/report.md',
        name: 'report.md',
        sha256: 'a'.repeat(64),
        size_bytes: 12,
        target_path: 'report.md'
      }
    ]
  }
  const result = compileSessionOutcomeWorkflow(plan, undefined, new Map([['astra', source]]))
  expect(result.predecessorReceipts).toEqual([])
  expect(result.currentInputs).toEqual([
    { stage_key: result.stages[0]!.key, mode: 'review-source', files: source.files }
  ])
  expect(result.stages[0]!.loop!.max_rounds).toBe(1)
  expect(result.stages[0]!.loop!.participants[0]).toBe('codex:gpt-5.6-terra')
})
it('authors bounded current-folder review rounds for the sealed snapshot materialization contract', () => {
  const plan = chain()
  // #284 (720690b3e) lowered this fixture's default to one round and refuses more than one round
  // without an authorized repair owner, so the bounded-rounds contract is stated explicitly here.
  plan.steps = plan.steps
    .slice(1)
    .map((entry) =>
      entry.kind === 'handoff' ? entry : { ...entry, review: { ...entry.review!, maxRounds: 2 } }
    )
  plan.steps.push(reviewRepairStep('gpt-5.6-terra', 'high'))
  plan.outcomeSet!.outcomes[0]!.stepIds = plan.steps.map((entry) => entry.id)
  const result = compileSessionOutcomeWorkflow(
    plan,
    undefined,
    new Map([
      [
        'astra',
        {
          provider: 'codex',
          model: 'gpt-5.6-terra',
          effort: 'high',
          files: [
            {
              rel: 'uploads/report.md',
              name: 'report.md',
              sha256: 'a'.repeat(64),
              size_bytes: 12,
              target_path: 'report.md'
            }
          ]
        }
      ]
    ])
  )
  expect(result.stages[0]!.loop!.max_rounds).toBe(2)
  expect(result.currentInputs[0]!.mode).toBe('review-source')
})

it('keeps repeated models in independent reviewer seats without overwriting their efforts', () => {
  const plan = chain()
  const reviewer = plan.steps[1]!
  if (reviewer.kind !== 'handoff') {
    reviewer.model = 'gpt-5.6-terra'
    reviewer.effort = 'low'
  }
  const loop = compileSessionOutcomeWorkflow(plan).stages[0]!.loop!
  expect(loop.participants).toEqual([
    'codex:gpt-5.6-terra',
    'codex:gpt-5.6-terra',
    'codex:gpt-5.6-sol'
  ])
  expect(new Set(loop.participant_ids).size).toBe(3)
  expect(loop.participant_efforts).toEqual({
    [loop.participant_ids![0]!]: 'high',
    [loop.participant_ids![1]!]: 'low',
    [loop.participant_ids![2]!]: 'high'
  })
  expect(compileSessionOutcomeWorkflow(plan).stages[0]!.loop!.participant_ids).toEqual(
    loop.participant_ids
  )
})
it('refuses unsupported review rounds instead of silently shortening the saved plan', () => {
  const plan = chain()
  const reviewer = plan.steps[1]!
  if (reviewer.kind !== 'handoff' && reviewer.review) {
    reviewer.review.maxRounds = 6
  }
  expect(() => compileSessionOutcomeWorkflow(plan)).toThrow('five rounds')
})

function mixedEffortPreview(
  mode: 'base' | 'review-source',
  mutate?: (nodes: ConsoleWorkflowNode[]) => void,
  sameModel = false
) {
  const plan = chain()
  Object.assign(plan.outcomeSet!.continuation, { taskId: 'btk_root', principal: 'person' })
  for (const step of plan.steps) {
    if (step.kind !== 'handoff' && step.review) {
      step.effort = step.id === 'astra' ? 'low' : undefined
      // The folder fixture below materializes two bounded rounds around one repair, which
      // #284 (720690b3e) only admits with an authorized repair owner of the producer's actor.
      step.review.maxRounds = 2
      if (sameModel) {
        step.model = 'gpt-5.6-terra'
      }
    }
  }
  plan.steps.push(reviewRepairStep('gpt-5.6-terra', 'high'))
  plan.outcomeSet!.outcomes[0]!.stepIds = plan.steps.map((entry) => entry.id)
  const source = folderRoundFixture(mode)
  let previous: SessionChain | undefined
  if (mode === 'review-source') {
    previous = structuredClone(plan)
    const workflow = workflowProofFixture().workflow
    workflow.phase = 'prepared'
    workflow.stages[0]!.outcomeIds = ['deliver']
    for (const node of workflow.preview.graph.nodes) {
      node.workspace = { kind: 'folder', host: 'local', path: '/repo' }
    }
    previous.outcomeSet!.workflow = workflow
    plan.steps = plan.steps.slice(1)
    plan.outcomeSet!.outcomes[0]!.stepIds = plan.steps.map((entry) => entry.id)
  }
  const preview = vi.fn<SessionOutcomeWorkflowPort['preview']>(async (_runtime, input) => {
    const stage = input.stages[0]!
    const result = source.workflow.preview
    for (const node of result.graph.nodes) {
      node.key = node.key.replace('build', stage.key!)
      node.brief = stage.prompt!
      node.loop_stage!.stage_key = stage.key!
      if (node.actor_type === 'ai') {
        node.effort =
          node.model === 'gpt-5.6-terra' ? 'high' : node.model === 'gpt-6-astra' ? 'low' : null
      }
      if (stage.loop?.participant_ids) {
        const ids = stage.loop.participant_ids
        node.loop_stage!.producer_participant_id = ids[0]!
        if (node.loop_stage!.role === 'participant') {
          node.loop_stage!.participant_id = ids[node.model === 'gpt-6-astra' ? 1 : 2]!
          node.model = 'gpt-5.6-terra'
        } else if (node.actor_type === 'ai') {
          node.loop_stage!.participant_id = ids[0]!
        }
      }
      if (mode === 'review-source') {
        node.current_source!.stage_key = stage.key!
        node.workspace = { kind: 'folder', host: 'local', path: '/repo' }
        node.source_files = node.current_source!.files
      } else {
        delete node.current_source
      }
    }
    mutate?.(result.graph.nodes)
    return result
  })
  installSessionOutcomeWorkflowPort({
    preview,
    captureCurrentInputs: vi.fn(async () => source.workflow.currentInputs![0]!.files)
  } as unknown as SessionOutcomeWorkflowPort)
  return {
    preview,
    prepare: () => prepareSessionOutcomeWorkflow({} as OrcaRuntimeService, plan, previous)
  }
}

it.each(['base', 'review-source'] as const)(
  'prepares a %s review with independent low/default efforts in every round and the original repair effort',
  async (mode) => {
    const fixture = mixedEffortPreview(mode)
    const saved = await fixture.prepare()
    expect(saved.outcomeSet!.workflow!.phase).toBe('prepared')
    expect(fixture.preview.mock.calls[0]![1].stages[0]!.loop!.participant_efforts).toEqual({
      'codex:gpt-5.6-terra': 'high',
      'codex:gpt-6-astra': 'low',
      'codex:gpt-5.6-sol': null
    })
    const nodes = saved.outcomeSet!.workflow!.preview.graph.nodes
    expect(nodes.filter((node) => node.loop_stage?.role === 'participant')).toHaveLength(4)
    expect(nodes.find((node) => node.action === 'repair')).toMatchObject({
      model: 'gpt-5.6-terra',
      effort: 'high'
    })
  }
)

it.each(['base', 'review-source'] as const)(
  'prepares independent same-model reviewer seats in %s mode with their own efforts',
  async (mode) => {
    const fixture = mixedEffortPreview(mode, undefined, true)
    const saved = await fixture.prepare()
    const loop = fixture.preview.mock.calls[0]![1].stages[0]!.loop!
    expect(loop.participants).toEqual(Array(3).fill('codex:gpt-5.6-terra'))
    expect(new Set(loop.participant_ids).size).toBe(3)
    expect(
      saved
        .outcomeSet!.workflow!.preview.graph.nodes.filter(
          (node) => node.loop_stage?.role === 'participant'
        )
        .map((node) => node.effort)
    ).toEqual(['low', null, 'low', null])
  }
)

it.each(['missing-seat', 'duplicate-seat', 'producer-seat', 'reviewer-effort'] as const)(
  'rejects a same-model preview with a changed %s',
  async (mutation) => {
    const fixture = mixedEffortPreview(
      'base',
      (nodes) => {
        const reviewers = nodes.filter((node) => node.loop_stage?.role === 'participant')
        if (mutation === 'missing-seat') {
          delete reviewers[0]!.loop_stage!.participant_id
        } else if (mutation === 'duplicate-seat') {
          reviewers[1]!.loop_stage!.participant_id = reviewers[0]!.loop_stage!.participant_id!
        } else if (mutation === 'producer-seat') {
          nodes.find((node) => node.action === 'repair')!.loop_stage!.participant_id = 'different'
        } else {
          reviewers[0]!.effort = null
        }
      },
      true
    )
    await expect(fixture.prepare()).rejects.toThrow(/identit|changed|unrequested/)
  }
)

it.each([
  'producer-effort',
  'repair-effort',
  'repair-model',
  'reviewer-effort',
  'reviewer-default',
  'reviewer-model',
  'reviewer-round'
] as const)('refuses %s changes in a mixed-effort preview', async (mutation) => {
  const fixture = mixedEffortPreview('base', (nodes) => {
    const producer = nodes.find((node) => node.action === 'execute')!
    const repair = nodes.find((node) => node.action === 'repair')!
    const reviewer = nodes.find(
      (node) => node.model === 'gpt-6-astra' && node.loop_stage?.round === 2
    )!
    const defaultReviewer = nodes.find((node) => node.model === 'gpt-5.6-sol')!
    if (mutation === 'producer-effort') {
      producer.effort = 'low'
    }
    if (mutation === 'repair-effort') {
      repair.effort = 'low'
    }
    if (mutation === 'repair-model') {
      repair.model = 'gpt-6-astra'
      repair.effort = 'low'
    }
    if (mutation === 'reviewer-effort') {
      reviewer.effort = 'high'
    }
    if (mutation === 'reviewer-default') {
      defaultReviewer.effort = 'high'
    }
    if (mutation === 'reviewer-model') {
      reviewer.model = 'unrequested-model'
    }
    if (mutation === 'reviewer-round') {
      reviewer.loop_stage!.round = 3
    }
  })
  await expect(fixture.prepare()).rejects.toThrow(/changed|unrequested/)
})

it('compiles only v2 while v1 remains in the durable chain', () => {
  const old = chain()
  const latest = old.steps.map((step) => ({ ...step, id: `v2_${step.id}`, planVersion: 2 }))
  const next = {
    ...old,
    planVersion: 2,
    steps: [...old.steps, ...latest],
    outcomeSet: {
      ...old.outcomeSet!,
      outcomes: old.outcomeSet!.outcomes.map((outcome) => ({
        ...outcome,
        stepIds: [...outcome.stepIds!, ...latest.map((step) => step.id)]
      }))
    }
  }
  const compiled = compileSessionOutcomeWorkflow(next)
  expect(compiled.bindings.flatMap((binding) => binding.stepIds)).toEqual(
    latest.map((step) => step.id)
  )
  expect(next.steps.slice(0, 3)).toEqual(old.steps)
})
