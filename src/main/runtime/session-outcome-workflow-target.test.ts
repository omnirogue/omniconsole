import { expect, it } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { sessionOutcomeWorkflowTarget } from './session-outcome-workflow-target'
import { sessionOutcomeAmendmentSources } from './session-outcome-workflow-sources'
import { sessionOutcomeReviewerIdentity } from './session-outcome-reviewer-identity'

const shaA = 'c'.repeat(40),
  shaB = 'd'.repeat(40)
function generation(name: string, candidate = shaA, ids = ['producer', 'astra', 'sol']) {
  const { workflow, jobs } = workflowProofFixture()
  workflow.closedStages = closedSessionOutcomeStages(workflow, jobs).map((stage) => ({
    key: stage.key,
    round: stage.round,
    reviewJobIds: stage.reviews.map((review) => review.jobId),
    producerJobId: stage.producer?.jobId,
    verificationReportId: stage.verificationReportId,
    evidenceId: stage.evidenceId
  }))
  workflow.preview.workflow_id = `wf_${name}`
  workflow.stages[0]!.stepIds = ids
  workflow.operationId = name
  for (const receipt of workflow.receipts!) {
    receipt.candidateSha = candidate
    if (receipt.verdict) {
      receipt.verdict.notes = `Reviewed ${candidate}`
    }
    receipt.jobId += name
  }
  workflow.closedStages[0]!.reviewJobIds = workflow
    .receipts!.slice(1)
    .map((receipt) => receipt.jobId)
  workflow.closedStages[0]!.producerJobId = workflow.receipts![0]!.jobId
  return workflow
}
function agent(id: string, model = 'gpt-5.6-terra', review = false): SessionChainAgentStep {
  return {
    id,
    agent: 'codex',
    model,
    prompt: id,
    status: 'queued',
    ...(review
      ? {
          review: { groupId: 'review', round: 1, maxRounds: 1, adversarial: false }
        }
      : {})
  } as SessionChainAgentStep
}
function fixture(history: SessionOutcomeWorkflow[] = [], current = generation('current')) {
  const condition = {
    id: 'merge',
    kind: 'merge' as const,
    target: 'Reviewed PR',
    targetBranch: 'main'
  }
  const chain = {
    steps: [
      agent('producer'),
      agent('astra', 'gpt-6-astra', true),
      agent('sol', 'gpt-5.6-sol', true)
    ],
    outcomeSet: {
      workflow: current,
      workflowHistory: history,
      outcomes: [
        {
          id: 'build',
          stepIds: ['producer', 'astra', 'sol'],
          actions: [],
          dependsOn: [],
          conditions: [condition]
        }
      ]
    }
  } as unknown as SessionChain
  return { chain, condition }
}

it('uses the producer branch and PR when real reviewers retain their own branch and null PR', () => {
  const { chain, condition } = fixture()
  const workflow = chain.outcomeSet!.workflow!
  workflow.receipts!.slice(1).forEach((receipt, index) => {
    receipt.branch = `omni/${receipt.jobId}-review-${index + 1}`
    receipt.prUrl = null
  })
  const target = sessionOutcomeWorkflowTarget(chain, condition)
  expect(target.receipt).toMatchObject({
    key: 'build',
    branch: 'omni/job_proof0',
    prUrl: 'https://github.com/omnirogue/fixture/pull/123'
  })
  expect(target.reviews.map(({ receipt }) => receipt.prUrl)).toEqual([null, null])
})
it('retains distinct immutable reviewer slots for the current frozen roster', () => {
  const { chain, condition } = fixture()
  const target = sessionOutcomeWorkflowTarget(chain, condition)
  expect(target.reviews.map((entry) => entry.receipt.model)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
  expect(target.expectedReviewerIds).toEqual([
    'wf_current:build__loop_r1_p1:codex/gpt-6-astra',
    'wf_current:build__loop_r1_p2:codex/gpt-5.6-sol'
  ])
})
it('keeps current same-model reviewer obligations tied to their exact seat receipts', () => {
  const { chain, condition } = fixture()
  const workflow = chain.outcomeSet!.workflow!
  const reviewers = chain.steps.slice(1) as SessionChainAgentStep[]
  const nodes = workflow.preview.graph.nodes.filter(
    (node) => node.loop_stage?.role === 'participant'
  )
  for (const [index, step] of reviewers.entries()) {
    step.model = 'gpt-6-astra'
    step.review!.reviewerId = step.id
    const node = nodes[index]!
    node.model = step.model
    node.loop_stage!.participant_id = sessionOutcomeReviewerIdentity(step.review!)
    workflow.receipts!.find((receipt) => receipt.key === node.key)!.model = step.model
  }
  expect(sessionOutcomeWorkflowTarget(chain, condition).reviews).toHaveLength(2)
  chain.outcomeSet!.outcomes[0]!.stepIds = ['producer', 'astra']
  expect(
    sessionOutcomeWorkflowTarget(chain, condition).reviews.map((entry) => entry.receipt.key)
  ).toEqual([nodes[0]!.key])
  reviewers[0]!.review!.reviewerId = 'a-different-session'
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('frozen participant')
})
it('selects the replacement candidate while preserving old candidate receipts', () => {
  const prior = generation('prior')
  const current = generation('current', shaB, ['newproducer', 'newastra', 'newsol'])
  const { chain, condition } = fixture([prior], current)
  chain.steps = [
    agent('newproducer'),
    agent('newastra', 'gpt-6-astra', true),
    agent('newsol', 'gpt-5.6-sol', true)
  ]
  chain.outcomeSet!.outcomes[0]!.stepIds = chain.steps.map((step) => step.id)
  const original = JSON.stringify(chain.outcomeSet!.workflowHistory)
  const target = sessionOutcomeWorkflowTarget(chain, condition)
  expect(target.receipt.candidateSha).toBe(shaB)
  expect(target.reviews.every((entry) => entry.workflow === current)).toBe(true)
  expect(JSON.stringify(chain.outcomeSet!.workflowHistory)).toBe(original)
})
it('does not publish an old closure while newly appended reviews are still pending', () => {
  const prior = generation('prior')
  const current = generation('appended', shaA, ['newastra', 'newsol'])
  current.closedStages = []
  const { chain, condition } = fixture([prior], current)
  chain.steps.push(agent('newastra', 'gpt-6-astra', true), agent('newsol', 'gpt-5.6-sol', true))
  chain.outcomeSet!.outcomes[0]!.stepIds = chain.steps.map((step) => step.id)
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('closed stage')
})
it('does not publish an old closure before new required review admission exists', () => {
  const { chain, condition } = fixture()
  chain.steps.push(agent('newreview', 'gpt-6-astra', true))
  chain.outcomeSet!.outcomes[0]!.stepIds!.push('newreview')
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('admitted stage')
})
it('collects appended accepted review groups without collapsing the same model slots', () => {
  const prior = generation('prior')
  const current = generation('appended', shaA, ['newastra', 'newsol'])
  const { chain, condition } = fixture([prior], current)
  chain.steps.push(agent('newastra', 'gpt-6-astra', true), agent('newsol', 'gpt-5.6-sol', true))
  chain.outcomeSet!.outcomes[0]!.stepIds = chain.steps.map((step) => step.id)
  const target = sessionOutcomeWorkflowTarget(chain, condition)
  expect(target.reviews).toHaveLength(4)
  expect(new Set(target.expectedReviewerIds).size).toBe(4)
})
it('keeps old group closure as producer proof without retaining removed reviewer obligations', () => {
  const prior = generation('prior')
  const current = generation('replaced', shaA, ['newastra', 'newsol'])
  const { chain, condition } = fixture([prior], current)
  chain.steps = [
    agent('producer'),
    agent('newastra', 'gpt-6-astra', true),
    agent('newsol', 'gpt-5.6-sol', true)
  ]
  chain.outcomeSet!.outcomes[0]!.stepIds = chain.steps.map((step) => step.id)
  expect(
    sessionOutcomeWorkflowTarget(chain, condition).reviews.map(
      (entry) => entry.workflow.operationId
    )
  ).toEqual(['replaced', 'replaced'])
})
it('rejects a stale current reviewer set even when a newer candidate is closed', () => {
  const prior = generation('prior')
  const current = generation('new', shaB, ['newproducer', 'newastra', 'newsol'])
  const { chain, condition } = fixture([prior], current)
  chain.steps.push(
    agent('newproducer'),
    agent('newastra', 'gpt-6-astra', true),
    agent('newsol', 'gpt-5.6-sol', true)
  )
  chain.outcomeSet!.outcomes[0]!.stepIds = chain.steps.map((step) => step.id)
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('selected candidate')
})
it.each(['missing', 'provider', 'key'] as const)('rejects %s frozen reviewer proof', (change) => {
  const { chain, condition } = fixture()
  const workflow = chain.outcomeSet!.workflow!
  if (change === 'missing') {
    workflow.closedStages![0]!.reviewJobIds.pop()
  } else {
    workflow.receipts![1]![change] = 'another'
  }
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('frozen review roster')
})
it('ignores a later unrelated outcome candidate for merge and source selection', () => {
  const own = generation('own')
  const unrelated = generation('unrelated', shaB, ['other'])
  unrelated.stages[0]!.outcomeIds = ['other']
  const { chain, condition } = fixture([own], unrelated)
  chain.outcomeSet!.outcomes.push({
    id: 'other',
    dependsOn: [],
    stepIds: ['other'],
    actions: [],
    conditions: []
  } as never)
  chain.steps.splice(1, 0, agent('other'))
  expect(sessionOutcomeWorkflowTarget(chain, condition).receipt.candidateSha).toBe(shaA)
  const sources = sessionOutcomeAmendmentSources(chain, [chain.steps.at(-1)!], [own, unrelated])
  expect(sources.get('sol')?.receipt.candidateSha).toBe(shaA)
})
it('does not adopt an earlier source when its outcome is unrelated', () => {
  const unrelated = generation('unrelated', shaB, ['other'])
  unrelated.stages[0]!.outcomeIds = ['other']
  const { chain } = fixture([], unrelated)
  chain.outcomeSet!.outcomes.push({
    id: 'other',
    dependsOn: [],
    stepIds: ['other'],
    actions: [],
    conditions: []
  } as never)
  chain.steps.unshift(agent('other'))
  expect(sessionOutcomeAmendmentSources(chain, [chain.steps.at(-1)!], [unrelated]).size).toBe(0)
})
it('allows declared transitive source dependencies regardless of display order', () => {
  const source = generation('source')
  source.stages[0]!.outcomeIds = ['dependency']
  const { chain } = fixture([], source)
  chain.outcomeSet!.outcomes[0]!.dependsOn = ['middle']
  chain.outcomeSet!.outcomes.push(
    { id: 'middle', dependsOn: ['dependency'], stepIds: [], actions: [], conditions: [] } as never,
    {
      id: 'dependency',
      dependsOn: [],
      stepIds: ['elsewhere'],
      actions: [],
      conditions: []
    } as never
  )
  expect(
    sessionOutcomeAmendmentSources(chain, [chain.steps[0]!], [source]).get('producer')?.receipt
      .candidateSha
  ).toBe(shaA)
})
it('selects the latest same-outcome accepted source with old and new candidates retained', () => {
  const { chain } = fixture()
  const old = generation('old'),
    current = generation('new', shaB)
  expect(
    sessionOutcomeAmendmentSources(chain, [chain.steps[2]!], [old, current]).get('sol')?.receipt
      .candidateSha
  ).toBe(shaB)
  expect(old.receipts![0]!.candidateSha).toBe(shaA)
})

it('refuses conflicting independent dependency candidates instead of using array order', () => {
  const first = generation('first')
  first.stages[0]!.outcomeIds = ['first']
  const second = generation('second', shaB)
  second.stages[0]!.outcomeIds = ['second']
  const { chain } = fixture()
  chain.outcomeSet!.outcomes[0]!.dependsOn = ['first', 'second']
  chain.outcomeSet!.outcomes.push(
    { id: 'first', dependsOn: [], stepIds: [], actions: [], conditions: [] } as never,
    { id: 'second', dependsOn: [], stepIds: [], actions: [], conditions: [] } as never
  )
  expect(() => sessionOutcomeAmendmentSources(chain, [chain.steps[0]!], [first, second])).toThrow(
    'different accepted source candidates'
  )
})
it('does not adopt a later same-outcome producer as an earlier step source', () => {
  const future = generation('future', shaB, ['future'])
  const { chain } = fixture()
  chain.steps.push(agent('future'))
  chain.outcomeSet!.outcomes[0]!.stepIds!.push('future')
  expect(sessionOutcomeAmendmentSources(chain, [chain.steps[0]!], [future]).size).toBe(0)
})
it('reuses the original producer receipt for its fresh amended identity', () => {
  const prior = generation('prior')
  const { chain } = fixture()
  const replacement = {
    ...agent('replacement'),
    editorStepId: 'draft_producer',
    replacedStepId: 'producer'
  }
  chain.steps[0] = replacement
  chain.outcomeSet!.outcomes[0]!.stepIds![0] = replacement.id
  expect(
    sessionOutcomeAmendmentSources(chain, [replacement], [prior]).get('replacement')?.receipt.jobId
  ).toBe(prior.receipts![0]!.jobId)
})

it('keeps identical condition text scoped to its explicit owning outcome', () => {
  const own = generation('own')
  const other = generation('other', shaB, ['otherproducer', 'otherastra', 'othersol'])
  other.stages[0]!.outcomeIds = ['other']
  const { chain, condition } = fixture([own], other)
  chain.steps.push(
    agent('otherproducer'),
    agent('otherastra', 'gpt-6-astra', true),
    agent('othersol', 'gpt-5.6-sol', true)
  )
  chain.outcomeSet!.outcomes.push({
    id: 'other',
    dependsOn: [],
    stepIds: ['otherproducer', 'otherastra', 'othersol'],
    actions: [],
    conditions: [{ ...condition }]
  } as never)
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('one owning outcome')
  expect(sessionOutcomeWorkflowTarget(chain, condition, 'build').receipt.candidateSha).toBe(shaA)
  expect(sessionOutcomeWorkflowTarget(chain, condition, 'other').receipt.candidateSha).toBe(shaB)
})

function loopless(finishCandidate: boolean, closeFinish = true, finishSha = shaA) {
  const base = generation('loopless')
  const receipt = (key: string, jobId: string, candidate: boolean, sha = shaA) => ({
    ...base.receipts![0]!,
    key,
    jobId,
    verificationReportId: `report_${key}`,
    ...(candidate ? { candidateSha: sha } : { candidateSha: null, branch: null, prUrl: null })
  })
  const node = (key: string) => ({
    ...base.preview.graph.nodes[0]!,
    key,
    loop_stage: undefined
  })
  const workflow: SessionOutcomeWorkflow = {
    ...base,
    preview: {
      ...base.preview,
      graph: { ...base.preview.graph, nodes: [node('build'), node('fin')] }
    },
    stages: [
      { key: 'build', stepIds: ['producer'], outcomeIds: ['build'], actionIds: [] },
      { key: 'fin', stepIds: [], outcomeIds: ['build'], actionIds: ['build_finish'] }
    ],
    receipts: [
      receipt('build', 'job_build', true, shaA),
      receipt('fin', 'job_fin', finishCandidate, finishSha)
    ],
    closedStages: [
      { key: 'build', reviewJobIds: [], verificationReportId: 'report_build' },
      ...(closeFinish ? [{ key: 'fin', reviewJobIds: [], verificationReportId: 'report_fin' }] : [])
    ]
  }
  const { chain, condition } = fixture([], workflow)
  chain.steps = [agent('producer')]
  chain.outcomeSet!.outcomes[0]!.stepIds = ['producer']
  chain.outcomeSet!.outcomes[0]!.actions = [
    { id: 'build_finish', instruction: 'Merge after checks pass', conditionIds: ['merge'] }
  ] as never
  return { chain, condition }
}
it('never lets a loopless finish action stage without its own reviewer roster supply the published candidate', () => {
  const { chain, condition } = loopless(true)
  const target = sessionOutcomeWorkflowTarget(chain, condition)
  expect(target.receipt).toMatchObject({ key: 'build', candidateSha: shaA })
  expect(target.reviews).toEqual([])
  expect(target.expectedReviewerIds).toEqual([])
})
it('refuses to publish an unreviewed finish-action push even when it names a different accepted candidate', () => {
  // Why: this is the case a bare `receipt: candidate ? own : undefined` let through unreviewed
  // (the finish action's own hub receipt reporting a pushed candidateSha the reviewers never saw).
  const { chain, condition } = loopless(true, true, shaB)
  const target = sessionOutcomeWorkflowTarget(chain, condition)
  expect(target.receipt).toMatchObject({ key: 'build', candidateSha: shaA })
  expect(target.receipt.candidateSha).not.toBe(shaB)
  expect(target.reviews).toEqual([])
})
it('keeps the producer candidate when the closed finish action produced no Git candidate', () => {
  const { chain, condition } = loopless(false)
  expect(sessionOutcomeWorkflowTarget(chain, condition).receipt.key).toBe('build')
})
it('still requires the finish action stage to close before publication', () => {
  const { chain, condition } = loopless(true, false)
  expect(() => sessionOutcomeWorkflowTarget(chain, condition)).toThrow('closed stage')
})
