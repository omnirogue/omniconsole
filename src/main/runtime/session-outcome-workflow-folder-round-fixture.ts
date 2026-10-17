import { createHash } from 'node:crypto'
import { canonicalDigestJson } from '../console-workflows/console-job-digests'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import type { ConsoleWorkflowGraph, ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import type { SessionOutcomeStageReceipt } from '../../shared/session-outcome-workflow'
export function folderRoundFixture(mode: 'base' | 'review-source' = 'review-source') {
  const f = workflowProofFixture()
  const originalBytes = Buffer.from('Initial report: defect remains.')
  const repairedBytes = Buffer.from('Repaired report: requested behavior is verified.')
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
  const file = {
    rel: 'uploads/report.txt',
    name: 'report.txt',
    sha256: hash(originalBytes),
    size_bytes: originalBytes.length,
    target_path: 'docs/report.txt'
  }
  const logical = (sha256: string, size_bytes: number) =>
    hash(canonicalDigestJson([{ target_path: file.target_path, sha256, size_bytes }]))
  const source = {
    schema_version: 1 as const,
    kind: 'current_task_files' as const,
    mode,
    stage_key: 'build',
    root_task_id: 'btk_root',
    files: [
      {
        kind: 'task_file' as const,
        task_id: 'btk_root',
        file: { rel: file.rel, name: file.name, sha256: file.sha256, size_bytes: file.size_bytes },
        target_path: file.target_path
      }
    ],
    snapshot_digest: logical(file.sha256, file.size_bytes),
    producer: { provider: 'codex', model: 'gpt-5.6-terra' }
  }
  const snapshot = {
    snapshot_digest: logical(hash(repairedBytes), repairedBytes.length),
    manifest: [
      {
        path: file.target_path,
        mode: 0o644,
        sha256: hash(repairedBytes),
        size_bytes: repairedBytes.length
      }
    ]
  }
  const artifactSha = hash(
    JSON.stringify({
      files: [
        {
          ...snapshot.manifest[0],
          content_b64: repairedBytes.toString('base64')
        }
      ]
    })
  )
  const nodes: ConsoleWorkflowGraph['nodes'] = []
  const jobs: ConsoleWorkflowJob[] = []
  const receipts: SessionOutcomeStageReceipt[] = []
  const shapes: [string, number, number][] = [
    ...(mode === 'base' ? [['producer', 0, 0] as [string, number, number]] : []),
    ['participant', 1, 1],
    ['participant', 1, 2],
    ['decide', 1, 3],
    ['repair', 1, 0],
    ['participant', 2, 1],
    ['participant', 2, 2],
    ['decide', 2, 3]
  ]
  for (const [index, [role, round, template]] of shapes.entries()) {
    const key = role === 'producer' ? 'build' : `build_${role}_${round}_${template}`
    const node = {
      ...structuredClone(f.workflow.preview.graph.nodes[template]!),
      key,
      action:
        role === 'repair' ? ('repair' as const) : f.workflow.preview.graph.nodes[template]!.action,
      repo: null,
      base_branch: null,
      current_source: structuredClone(source),
      loop_stage: {
        stage_key: 'build',
        branch_group: 'build__loop',
        producer_key: 'build',
        role,
        round
      },
      ...(role !== 'decide'
        ? {
            artifact_result: {
              path: role === 'participant' ? 'folder-review.json' : 'folder-snapshot.json',
              format: 'json',
              max_bytes: 65536
            }
          }
        : {})
    }
    if (node.mechanical_execution) {
      node.mechanical_execution.input.round = round
      node.mechanical_execution.input.max_rounds = 2
      node.mechanical_execution.input.participant_node_keys = [1, 2].map(
        (slot) => `build_participant_${round}_${slot}`
      )
    }
    nodes.push(node)
    const job = structuredClone(f.jobs[template]!)
    job.id = `job_folder000${index}`
    job.task_id = `btk_folderchild${index}`
    job.node_id = key
    job.status = 'done'
    Object.assign(job.policy.workflow, {
      key,
      action: node.action,
      loop_stage: node.loop_stage,
      current_source: structuredClone(source)
    })
    const projection = job.policy.workflow.hub_projection!
    projection.verification_report_id = `report_folder_${index}`
    projection.satisfied = role !== 'decide' || round === 2
    projection.terminal_loop_resolutions =
      role === 'decide' && round === 2
        ? [
            {
              ...(f.jobs[3]!.policy.workflow.hub_projection!
                .terminal_loop_resolutions![0] as object),
              selector_node_key: key,
              verification_report_id: projection.verification_report_id
            }
          ]
        : []
    jobs.push(job)
    if (role === 'decide') {
      continue
    }
    const receipt: SessionOutcomeStageReceipt = {
      ...structuredClone(f.workflow.receipts![template === 0 ? 0 : template]!),
      jobId: job.id,
      taskId: job.task_id,
      key,
      eventId: 100 + index * 2,
      inputDigest: 'd'.repeat(64),
      verificationReportId: String(projection.verification_report_id),
      candidateSha: null,
      branch: null,
      prUrl: null,
      folderArtifact: {
        resultEventId: 99 + index * 2,
        fileId: `tfl_folder${index}`,
        sha256: artifactSha,
        ...(role === 'participant'
          ? {
              reviewedSnapshot: {
                schema_version: 1,
                kind: 'current_task_files',
                snapshot_digest: source.snapshot_digest
              }
            }
          : { folderSnapshot: structuredClone(snapshot) })
      }
    }
    if (role === 'participant') {
      receipt.verdict = {
        verdict: round === 1 ? 'disagree' : 'agree',
        blockers: round === 1 ? ['Defect remains'] : [],
        gaps: [],
        notes: 'Exact snapshot binding is retained in the verified artifact.'
      }
    }
    receipts.push(receipt)
  }
  const repair = receipts.find((receipt) => receipt.key.includes('repair'))!
  const reviewed = {
    schema_version: 1 as const,
    kind: 'accepted_folder_snapshot' as const,
    snapshot_digest: snapshot.snapshot_digest,
    artifact_sha256: repair.folderArtifact!.sha256,
    source_job_id: repair.jobId,
    source_attempt: repair.attempt
  }
  for (const receipt of receipts.filter((entry) => entry.key.includes('participant_2'))) {
    receipt.folderArtifact!.reviewedSnapshot = { ...reviewed }
  }
  if (mode === 'base') {
    const producer = receipts[0]!
    for (const receipt of receipts.filter((entry) => entry.key.includes('participant_1'))) {
      receipt.folderArtifact!.reviewedSnapshot = {
        ...reviewed,
        source_job_id: producer.jobId,
        source_attempt: producer.attempt
      }
    }
  }
  f.workflow.preview.graph.nodes = nodes
  f.workflow.receipts = receipts
  f.workflow.currentInputs = [{ stage_key: 'build', mode, files: [file] }]
  return { ...f, jobs, source, snapshot, repair, originalBytes, repairedBytes }
}
