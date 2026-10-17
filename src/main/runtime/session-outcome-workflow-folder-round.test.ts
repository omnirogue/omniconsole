import { expect, it } from 'vitest'
import { folderRoundFixture } from './session-outcome-workflow-folder-round-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
it.each(['base', 'review-source'] as const)(
  'closes a %s folder loop over changed accepted repair bytes and independently verified round-two reviews',
  (mode) => {
    const f = folderRoundFixture(mode)
    expect(f.originalBytes.equals(f.repairedBytes)).toBe(false)
    expect(f.snapshot.snapshot_digest).not.toBe(f.source.snapshot_digest)
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([
      {
        key: 'build',
        round: 2,
        reviews: [
          {
            candidateSha: null,
            folderArtifact: { reviewedSnapshot: { snapshot_digest: f.snapshot.snapshot_digest } }
          },
          {
            candidateSha: null,
            folderArtifact: { reviewedSnapshot: { snapshot_digest: f.snapshot.snapshot_digest } }
          }
        ]
      }
    ])
  }
)
it.each([
  'initial-snapshot',
  'wrong-artifact',
  'wrong-source-job',
  'wrong-source-attempt',
  'missing-review-metadata',
  'missing-producer-metadata',
  'unverified-producer',
  'stale-producer-claim',
  'wrong-producer-model',
  'wrong-producer-round',
  'outside-selection',
  'changed-manifest',
  'duplicate-path',
  'generic-report-path',
  'legacy-review-path',
  'later-result-event',
  'review-input-digest'
] as const)('refuses %s in a repaired folder closure', (mutation) => {
  const f = folderRoundFixture()
  const review = f.workflow.receipts!.find((receipt) => receipt.key.includes('participant_2'))!
  const binding = review.folderArtifact!.reviewedSnapshot!
  if (binding.kind !== 'accepted_folder_snapshot') {
    throw new Error('Fixture must review the accepted repair.')
  }
  const producerNode = f.workflow.preview.graph.nodes.find((node) => node.key === f.repair.key)!
  const producerJob = f.jobs.find((job) => job.id === f.repair.jobId)!
  if (mutation === 'initial-snapshot') {
    binding.snapshot_digest = f.source.snapshot_digest
  }
  if (mutation === 'wrong-artifact') {
    binding.artifact_sha256 = '0'.repeat(64)
  }
  if (mutation === 'wrong-source-job') {
    binding.source_job_id = 'job_unrelated000'
  }
  if (mutation === 'wrong-source-attempt') {
    binding.source_attempt++
  }
  if (mutation === 'missing-review-metadata') {
    delete review.folderArtifact
  }
  if (mutation === 'missing-producer-metadata') {
    delete f.repair.folderArtifact
  }
  if (mutation === 'unverified-producer') {
    producerJob.policy.workflow.hub_projection!.satisfied = false
  }
  if (mutation === 'stale-producer-claim') {
    producerJob.attempt = 99
  }
  if (mutation === 'wrong-producer-model') {
    producerNode.model = 'gpt-6-astra'
  }
  if (mutation === 'wrong-producer-round') {
    producerNode.loop_stage!.round = 0
  }
  if (mutation === 'outside-selection') {
    f.repair.folderArtifact!.folderSnapshot!.manifest[0]!.path = 'secret.txt'
  }
  if (mutation === 'changed-manifest') {
    f.repair.folderArtifact!.folderSnapshot!.manifest[0]!.sha256 = '0'.repeat(64)
  }
  if (mutation === 'duplicate-path') {
    f.repair.folderArtifact!.folderSnapshot!.manifest.push({
      ...f.repair.folderArtifact!.folderSnapshot!.manifest[0]!
    })
  }
  if (mutation === 'generic-report-path') {
    Object.assign(producerNode, {
      artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 }
    })
  }
  if (mutation === 'legacy-review-path') {
    Object.assign(
      f.workflow.preview.graph.nodes.find((node) => node.key === review.key)!,
      { artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 } }
    )
  }
  if (mutation === 'later-result-event') {
    review.folderArtifact!.resultEventId = review.eventId + 1
  }
  if (mutation === 'review-input-digest') {
    delete review.inputDigest
  }
  expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
})

it.each(['base', 'review-source'] as const)(
  'honors canonical early closure for %s without requiring a future repair snapshot',
  (mode) => {
    const f = folderRoundFixture(mode)
    const firstDecision = f.jobs.find(
      (job) =>
        job.policy.workflow.loop_stage?.role === 'decide' &&
        job.policy.workflow.loop_stage.round === 1
    )!
    const lastDecision = f.jobs.find(
      (job) =>
        job.policy.workflow.loop_stage?.role === 'decide' &&
        job.policy.workflow.loop_stage.round === 2
    )!
    firstDecision.policy.workflow.hub_projection!.satisfied = true
    const receipt = {
      ...(
        lastDecision.policy.workflow.hub_projection!.terminal_loop_resolutions as Record<
          string,
          never
        >[]
      )[0]!
    }
    Object.assign(receipt, {
      selector_node_key: firstDecision.policy.workflow.key,
      verification_report_id: firstDecision.policy.workflow.hub_projection!.verification_report_id
    })
    firstDecision.policy.workflow.hub_projection!.terminal_loop_resolutions = [receipt]
    for (const review of f.workflow.receipts!.filter((entry) =>
      entry.key.includes('participant_1')
    )) {
      review.verdict = { verdict: 'agree', blockers: [], gaps: [], notes: '' }
    }
    const repairJob = f.jobs.find((job) => job.id === f.repair.jobId)!
    repairJob.policy.workflow.hub_projection!.satisfied = false
    delete f.repair.folderArtifact
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([
      { key: 'build', round: 1 }
    ])
  }
)
