import { expect, it } from 'vitest'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { readSessionOutcomeCanonicalSeal } from './session-outcome-workflow-seal'

it('retains the actual canonical revision seal separately from the BFF digest', () => {
  const { workflow, jobs, bffDigest, canonicalDigest } = workflowProofFixture()
  expect(bffDigest).not.toBe(canonicalDigest)
  expect(
    readSessionOutcomeCanonicalSeal(
      { receipt: { workflow_id: workflow.preview.workflow_id, revision: workflow.canonicalSeal } },
      workflow.preview.workflow_id
    )
  ).toEqual(workflow.canonicalSeal)
  expect(closedSessionOutcomeStages(workflow, jobs)).toMatchObject([
    {
      key: 'build',
      round: 1,
      verificationReportId: 'report_3',
      evidenceId: 'evidence_closed',
      reviews: [{ model: 'gpt-6-astra' }, { model: 'gpt-5.6-sol' }]
    }
  ])
})
it('rejects admission receipts from another workflow or without a revision', () => {
  const { workflow } = workflowProofFixture()
  expect(() =>
    readSessionOutcomeCanonicalSeal(
      { receipt: { workflow_id: 'wf_other', revision: workflow.canonicalSeal } },
      workflow.preview.workflow_id
    )
  ).toThrow()
  expect(() => readSessionOutcomeCanonicalSeal({}, workflow.preview.workflow_id)).toThrow()
})
it.each(['digest', 'revision', 'decision', 'report', 'evidence', 'generic-empty'] as const)(
  'does not close a terminal loop with invalid %s proof',
  (kind) => {
    const { workflow, jobs } = workflowProofFixture()
    const projection = jobs[3]!.policy.workflow.hub_projection!
    const closure = (projection.terminal_loop_resolutions as Record<string, unknown>[])[0]!
    if (kind === 'digest') {
      projection.graph_digest = workflow.preview.digest
    }
    if (kind === 'revision') {
      projection.revision_id = 'rev_other'
    }
    if (kind === 'decision') {
      closure.decision = 'open'
    }
    if (kind === 'report') {
      closure.verification_report_id = 'stale'
    }
    if (kind === 'evidence') {
      closure.evidence_id = ''
    }
    if (kind === 'generic-empty') {
      projection.branch_resolutions = projection.terminal_loop_resolutions!
      delete projection.terminal_loop_resolutions
    }
    expect(closedSessionOutcomeStages(workflow, jobs)).toEqual([])
  }
)
it.each(['candidate', 'model', 'withdrawn', 'blockers', 'missing-producer'] as const)(
  'does not project accepted notes without exact current %s evidence',
  (kind) => {
    const { workflow, jobs } = workflowProofFixture()
    const review = workflow.receipts![1]!
    if (kind === 'candidate') {
      review.candidateSha = 'f'.repeat(40)
      review.verdict!.notes = review.candidateSha
    }
    if (kind === 'model') {
      review.model = 'gpt-5.6-terra'
    }
    if (kind === 'withdrawn') {
      jobs[1]!.policy.workflow.hub_projection!.satisfied = false
    }
    if (kind === 'blockers') {
      review.verdict!.blockers = ['Open blocker']
    }
    if (kind === 'missing-producer') {
      workflow.receipts!.shift()
    }
    expect(closedSessionOutcomeStages(workflow, jobs)).toEqual([])
  }
)

it('closes against the producer candidate when real reviewers use their own branches and no PR', () => {
  const { workflow, jobs, candidate } = workflowProofFixture()
  workflow.receipts!.slice(1).forEach((receipt, index) => {
    receipt.branch = `omni/${receipt.jobId}-review-${index + 1}`
    receipt.prUrl = null
  })
  expect(closedSessionOutcomeStages(workflow, jobs)).toMatchObject([
    {
      key: 'build',
      reviews: [
        { candidateSha: candidate, branch: expect.stringContaining('-review-'), prUrl: null },
        { candidateSha: candidate, branch: expect.stringContaining('-review-'), prUrl: null }
      ]
    }
  ])
})
