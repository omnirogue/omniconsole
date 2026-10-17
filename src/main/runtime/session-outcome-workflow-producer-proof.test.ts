import { expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { projectSessionOutcomeStageCompletion } from './session-outcome-workflow-completion'
import { sessionOutcomeWorkflowTarget } from './session-outcome-workflow-target'
import { sessionOutcomeWorkflowSchema } from '../../shared/session-outcome-workflow'

function generation(suffix: string) {
  const f = workflowProofFixture()
  f.workflow.operationId = suffix
  f.workflow.preview.workflow_id += suffix
  f.workflow.preview.graph.dispatch_id = f.workflow.preview.workflow_id
  f.workflow.canonicalSeal!.workflow_id = f.workflow.preview.workflow_id
  f.workflow.canonicalSeal!.revision_id += suffix
  f.jobs.forEach((job) => {
    job.id += suffix
    job.policy.workflow.workflow_id = f.workflow.preview.workflow_id
    job.policy.workflow.dispatch_id = f.workflow.preview.workflow_id
    Object.assign(job.policy.workflow.hub_projection!, f.workflow.canonicalSeal)
    const rows = job.policy.workflow.hub_projection!.terminal_loop_resolutions
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          row.revision_id = f.workflow.canonicalSeal!.revision_id
        }
      }
    }
  })
  f.workflow.receipts!.forEach((receipt) => {
    receipt.jobId += suffix
  })
  f.workflow.activations = f.workflow.receipts!.map((receipt) => ({
    jobId: receipt.jobId,
    state: 'started',
    dispatchId: receipt.dispatchId,
    runId: receipt.runId
  }))
  return f
}
function fixture() {
  const prior = generation('prior'),
    current = generation('current')
  prior.workflow.retired = true
  prior.workflow.closedStages = []
  prior.jobs.slice(1).forEach((job) => {
    job.policy.workflow.hub_projection!.satisfied = false
  })
  const producer = prior.workflow.receipts![0]!
  current.workflow.stages[0]!.stepIds = ['newastra', 'newsol']
  current.workflow.predecessorReceipts = [
    {
      stage_key: 'build',
      mode: 'review-source',
      job_id: producer.jobId,
      receipt_event_id: producer.eventId,
      fingerprint: producer.fingerprint
    }
  ]
  current.workflow.preview.graph.nodes = current.workflow.preview.graph.nodes
    .slice(1)
    .map((node) => ({
      ...node,
      after: node.action === 'review' ? [] : node.after,
      external_predecessor: {
        mode: 'review-source',
        job_id: producer.jobId,
        receipt_event_id: producer.eventId,
        fingerprint: producer.fingerprint,
        root_task_id: 'btk_root',
        task_id: producer.taskId,
        producer_key: producer.key,
        verification_report_id: producer.verificationReportId,
        canonical_workflow: prior.workflow.canonicalSeal!,
        candidate: {
          candidate_sha: producer.candidateSha,
          branch: producer.branch,
          pr_url: producer.prUrl
        }
      }
    }))
  current.workflow.receipts = current.workflow.receipts!.slice(1)
  current.jobs = current.jobs.slice(1)
  current.workflow.closedStages = closedSessionOutcomeStages(current.workflow, current.jobs, [
    prior.workflow
  ]).map((entry) => ({
    key: entry.key,
    round: entry.round,
    verificationReportId: entry.verificationReportId,
    evidenceId: entry.evidenceId,
    reviewJobIds: entry.reviews.map((review) => review.jobId),
    producerJobId: entry.producer?.jobId
  }))
  expect(current.workflow.closedStages).toHaveLength(1)
  const condition = {
    id: 'merge',
    kind: 'merge' as const,
    target: 'Reviewed PR',
    targetBranch: 'main'
  }
  const chain = {
    id: 'partial',
    currentIndex: 0,
    steps: [
      { id: 'producer', agent: 'codex', model: 'gpt-5.6-terra', prompt: 'Build', status: 'queued' },
      {
        id: 'newastra',
        agent: 'codex',
        model: 'gpt-6-astra',
        prompt: 'Review',
        status: 'queued',
        review: { groupId: 'review', round: 1, maxRounds: 1 }
      },
      {
        id: 'newsol',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        prompt: 'Review',
        status: 'queued',
        review: { groupId: 'review', round: 1, maxRounds: 1 }
      }
    ],
    outcomeSet: {
      revision: 1,
      workflow: current.workflow,
      workflowHistory: [prior.workflow],
      completedSteps: [],
      attempts: [],
      continuation: { taskId: 'btk_root' },
      outcomes: [
        {
          id: 'build',
          stepIds: ['producer', 'newastra', 'newsol'],
          actions: [],
          dependsOn: [],
          conditions: [condition],
          evidence: [],
          status: 'pending'
        }
      ]
    }
  } as unknown as SessionChain
  const service = { save: (next: SessionChain) => next } as unknown as SessionOutcomeService
  const verified = projectSessionOutcomeStageCompletion(
    service,
    chain,
    prior.workflow,
    [],
    prior.jobs
  )
  return { prior, current, chain: verified, condition, service, producer }
}
it('publishes a genuinely closed replacement review-source without closing the cancelled original loop', () => {
  const { chain, condition, prior, current, producer } = fixture()
  expect(chain.outcomeSet!.workflowHistory![0]!.verifiedProducerReceipts).toEqual([producer])
  const target = sessionOutcomeWorkflowTarget(chain, condition, 'build')
  expect(target.workflow.operationId).toBe('current')
  expect(target.closed).toBe(current.workflow.closedStages![0])
  expect(target.reviews.map((entry) => entry.receipt.model)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
  expect(prior.workflow.closedStages).toEqual([])
  expect(chain.outcomeSet!.workflowHistory![0]!.closedStages).toEqual([])
})
it('serializes the bounded independently verified receipt proof through the existing workflow schema', () => {
  const { chain, producer } = fixture()
  const decoded = sessionOutcomeWorkflowSchema.parse(chain.outcomeSet!.workflowHistory![0])
  expect(decoded.verifiedProducerReceipts).toEqual([producer])
})
it.each([
  'missing',
  'model',
  'task',
  'attempt',
  'event',
  'fingerprint',
  'report',
  'error'
] as const)(
  'rejects missing or changed independent %s proof even when completedSteps includes producer',
  (change) => {
    const { chain, condition } = fixture()
    chain.outcomeSet!.completedSteps = ['producer', 'newastra', 'newsol']
    const prior = chain.outcomeSet!.workflowHistory![0]!
    const proof = structuredClone(prior.verifiedProducerReceipts![0]!)
    prior.verifiedProducerReceipts = [proof]
    if (change === 'missing') {
      prior.verifiedProducerReceipts = []
    }
    if (change === 'model') {
      proof.model = 'other'
    }
    if (change === 'task') {
      proof.taskId = 'btk_other'
    }
    if (change === 'attempt') {
      proof.attempt += 1
    }
    if (change === 'event') {
      proof.eventId += 1
    }
    if (change === 'fingerprint') {
      proof.fingerprint = 'f'.repeat(64)
    }
    if (change === 'report') {
      proof.verificationReportId = 'other'
    }
    if (change === 'error') {
      prior.error = 'Current source verification unavailable.'
    }
    expect(() => sessionOutcomeWorkflowTarget(chain, condition, 'build')).toThrow('closed stage')
  }
)
it('clears independent proof after current source verification is revoked', () => {
  const { chain, condition, prior, service } = fixture()
  prior.jobs[0]!.policy.workflow.hub_projection!.satisfied = false
  const next = projectSessionOutcomeStageCompletion(
    service,
    chain,
    chain.outcomeSet!.workflowHistory![0]!,
    [],
    prior.jobs
  )
  expect(next.outcomeSet!.workflowHistory![0]!.verifiedProducerReceipts).toEqual([])
  expect(() => sessionOutcomeWorkflowTarget(next, condition, 'build')).toThrow('closed stage')
})
it('still requires actual closure of every current replacement reviewer', () => {
  const { chain, condition } = fixture()
  chain.outcomeSet!.workflow!.closedStages = []
  expect(() => sessionOutcomeWorkflowTarget(chain, condition, 'build')).toThrow('closed stage')
})
it('does not use partial producer proof while an original reviewer is still required', () => {
  const { chain, condition } = fixture()
  chain.steps.push({
    id: 'astra',
    agent: 'codex',
    model: 'gpt-6-astra',
    prompt: 'Still required',
    status: 'queued',
    review: { groupId: 'review', round: 1, maxRounds: 1 }
  } as never)
  chain.outcomeSet!.outcomes[0]!.stepIds!.push('astra')
  expect(() => sessionOutcomeWorkflowTarget(chain, condition, 'build')).toThrow('closed stage')
})
