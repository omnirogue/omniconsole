import { expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
it('verifies identical condition text against its own outcome lineage rather than pooling independent candidates', async () => {
  const left = workflowProofFixture(),
    right = workflowProofFixture()
  for (const [id, f] of [
    ['left', left],
    ['right', right]
  ] as const) {
    f.workflow.operationId = id
    f.workflow.stages[0]!.outcomeIds = [id]
    f.workflow.closedStages = closedSessionOutcomeStages(f.workflow, f.jobs).map((closed) => ({
      key: closed.key,
      round: closed.round,
      reviewJobIds: closed.reviews.map((receipt) => receipt.jobId),
      producerJobId: closed.producer?.jobId,
      verificationReportId: closed.verificationReportId,
      evidenceId: closed.evidenceId
    }))
  }
  const head = 'e'.repeat(40),
    branch = 'omni/job_right',
    url = 'https://github.com/omnirogue/fixture/pull/124'
  const rightJobIds = new Map<string, string>()
  right.workflow.receipts = right.workflow.receipts!.map((receipt) => {
    const jobId = `${receipt.jobId}_right`
    rightJobIds.set(receipt.jobId, jobId)
    return {
      ...receipt,
      jobId,
      candidateSha: head,
      branch,
      prUrl: url,
      ...(receipt.verdict ? { verdict: { ...receipt.verdict, notes: `Reviewed ${head}` } } : {})
    }
  })
  right.workflow.closedStages = right.workflow.closedStages!.map((closed) => ({
    ...closed,
    reviewJobIds: closed.reviewJobIds.map((id) => rightJobIds.get(id)!),
    producerJobId: closed.producerJobId ? rightJobIds.get(closed.producerJobId) : undefined
  }))
  const condition = {
    id: 'pr',
    kind: 'pr' as const,
    target: 'Reviewed PR',
    repository: 'repo',
    targetBranch: 'main'
  }
  const outcomes = ['left', 'right'].map((id) => ({
    id,
    title: id,
    finish: 'pr' as const,
    revision: 1,
    status: 'pending' as const,
    dependsOn: [],
    conditions: [condition],
    actions: [],
    evidence: []
  }))
  const chain = {
    id: 'evidence',
    workspacePath: '/work',
    steps: [],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes,
      attempts: [],
      removals: [],
      updatedAt: 1,
      workflow: right.workflow,
      workflowHistory: [left.workflow],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' }
    }
  } as unknown as SessionChain
  const get = vi.fn(async () => ({
    kind: 'found',
    pr: { number: 124, url, headSha: head, baseRefName: 'main', state: 'open' }
  }))
  const runtime = { getRepoPRForBranch: get } as unknown as OrcaRuntimeService
  const result = await verifySessionOutcomeProgress(runtime, chain, chain.outcomeSet!.outcomes[1]!)
  expect(get).toHaveBeenCalledWith('repo', branch, 124, 124, true, head, 'manual')
  expect(result.set.outcomes[1]!.evidence[0]!.receipt).toContain(`${url}@${head}`)
  expect(result.set.outcomes[0]!.evidence).toEqual([])
})
