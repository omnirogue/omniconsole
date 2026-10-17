import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { consoleJobClaimFixture } from './orchestration/console-job-test-fixture'
import {
  consoleLocalJobSchema,
  consoleLocalResultSchema
} from '../console-workflows/console-local-execution-schema'
import {
  consoleFolderRoundArtifact,
  hydrateConsoleFolderCandidate
} from '../console-workflows/console-folder-round-snapshot'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sessionOutcomeWorkflowPreview } from '../../shared/session-outcome-workflow'
import { assertSessionOutcomeFolderLoopContract } from './session-outcome-workflow-folder-contract'
import { readSessionOutcomeFolderArtifact } from '../backoffice/session-outcome-folder-result'
const wire = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'bff-folder-round.json'), 'utf8')
)
function fixture() {
  const preview = sessionOutcomeWorkflowPreview.parse(structuredClone(wire.preview))
  const source = preview.graph.nodes[0]!.current_source!
  const stage = {
    key: source.stage_key,
    title: 'Review current files',
    actor: 'codex:gpt-5.6-terra',
    loop: {
      kind: 'review' as const,
      participants: ['codex:gpt-5.6-terra', 'codex:gpt-6-astra', 'codex:gpt-5.6-sol'],
      max_rounds: 2,
      stop_rule: 'zero_blockers' as const
    }
  }
  const input = {
    stage_key: source.stage_key,
    mode: source.mode,
    files: source.files.map((file) => ({ ...file.file, target_path: file.target_path }))
  }
  return { preview, stage, input }
}
it('accepts the actual two-round BFF preview only with sealed snapshot/review consumer contracts', () => {
  const f = fixture()
  expect(() =>
    assertSessionOutcomeFolderLoopContract(f.preview.graph, f.stage, f.input)
  ).not.toThrow()
})
it.each(['old-consumer', 'missing-repair', 'input-drift', 'wrong-limit'] as const)(
  'refuses actual preview %s before admission',
  (mutation) => {
    const f = fixture()
    const review = f.preview.graph.nodes.find((node) => node.loop_stage?.role === 'participant')!
    if (mutation === 'old-consumer') {
      Object.assign(review, {
        artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 }
      })
    }
    if (mutation === 'missing-repair') {
      f.preview.graph.nodes = f.preview.graph.nodes.filter(
        (node) => node.loop_stage?.role !== 'repair'
      )
    }
    if (mutation === 'input-drift') {
      review.current_source!.snapshot_digest = '0'.repeat(64)
    }
    if (mutation === 'wrong-limit') {
      Object.assign(review, {
        artifact_result: { path: 'folder-review.json', format: 'json', max_bytes: 99999 }
      })
    }
    expect(() =>
      assertSessionOutcomeFolderLoopContract(f.preview.graph, f.stage, f.input)
    ).toThrow()
  }
)
it('reads server-added reviewed snapshot metadata from actual PostgreSQL upload/result wire facts without changing runner payload', () => {
  const event = wire.review_result_event
  const detail = event.detail
  const result = consoleLocalResultSchema.parse({
    status: detail.status,
    result_exit_code: detail.result_exit_code,
    exit_code: 0,
    output_tail: '',
    output_digest: detail.output_digest,
    terminal_proof: detail.terminal_proof,
    file_id: detail.file_id,
    artifact_sha256: detail.artifact_sha256,
    changed_files: detail.changed_files,
    owned_paths_violations: detail.owned_paths_violations,
    candidate_sha: null,
    branch: null,
    pr_url: null,
    pr_number: null,
    workflow_loop_verdict: detail.workflow_loop_verdict
  })
  const artifact = readSessionOutcomeFolderArtifact(
    [event],
    wire.review_runner_receipt.id,
    result,
    {
      attempt: detail.attempt,
      leaseGeneration: detail.lease_generation,
      claimedAt: detail.claimed_at
    }
  )
  expect(artifact?.reviewedSnapshot).toEqual(wire.review_artifact.reviewed_snapshot)
  expect(artifact?.fileId).toBe(wire.review_artifact.file_id)
  expect(artifact?.sha256).toBe(wire.review_artifact.sha256)
  expect(result).not.toHaveProperty('reviewed_snapshot')
})

it('preserves queued user edits and accepts the actual BFF repair bytes for the typed review snapshot binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-folder-wire-'))
  try {
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs/report.txt'), 'stale original bytes')
    const { preview } = fixture()
    const node = preview.graph.nodes.find(
      (entry) =>
        entry.key ===
        wire.review_result_event.source_snapshot.detail.execution_binding.contract_id.slice(3)
    )!
    expect(node.loop_stage?.round).toBe(2)
    const job = consoleLocalJobSchema.parse({
      id: wire.review_artifact.job_id,
      taskId: wire.review_result_event.source_snapshot.task_id,
      workflowId: preview.workflow_id,
      digest: preview.digest,
      state: 'running',
      placement: 'local',
      provider: node.provider,
      model: node.model,
      title: node.title,
      workspace: { kind: 'folder', path: root },
      repo: null,
      baseSha: null,
      baseBranch: null,
      prompt: node.brief,
      brief: node.brief,
      acceptance: 'Review exact accepted folder bytes.',
      inputs: [
        {
          loop_stage: node.loop_stage,
          current_source: node.current_source,
          source_files: node.source_files,
          folder_candidate: wire.folder_input.candidate
        }
      ],
      ownedPaths: null,
      readOnly: true,
      action: 'review',
      acceptanceCommands: [],
      artifactResult: { path: 'folder-review.json', format: 'json', maxBytes: 65536 }
    })
    await expect(
      hydrateConsoleFolderCandidate({
        activation: {
          job,
          principal: 'a'.repeat(64),
          binding: { ...consoleJobClaimFixture, jobId: job.id }
        },
        workspacePath: root,
        candidate: wire.folder_input.candidate,
        contentBase64: wire.folder_input.content_b64
      })
    ).rejects.toThrow('changed after its authorized snapshot')
    expect(await readFile(join(root, 'docs/report.txt'), 'utf8')).toBe('stale original bytes')
    const acceptedBytes = JSON.parse(
      Buffer.from(wire.folder_input.content_b64, 'base64').toString('utf8')
    ).files[0].content_b64
    await writeFile(join(root, 'docs/report.txt'), Buffer.from(acceptedBytes, 'base64'))
    await hydrateConsoleFolderCandidate({
      activation: {
        job,
        principal: 'a'.repeat(64),
        binding: { ...consoleJobClaimFixture, jobId: job.id }
      },
      workspacePath: root,
      candidate: wire.folder_input.candidate,
      contentBase64: wire.folder_input.content_b64
    })
    const bytes = await readFile(join(root, 'docs/report.txt'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      wire.folder_input.candidate.manifest[0].sha256
    )
    const detail = wire.review_result_event.detail
    const result = consoleLocalResultSchema.parse({
      status: 'done',
      exit_code: 0,
      result_exit_code: 0,
      output_tail: '',
      output_digest: detail.output_digest,
      terminal_proof: detail.terminal_proof,
      candidate_sha: null,
      branch: null,
      pr_url: null,
      pr_number: null,
      changed_files: [],
      owned_paths_violations: [],
      workflow_loop_verdict: detail.workflow_loop_verdict
    })
    const artifact = await consoleFolderRoundArtifact(
      job,
      wire.review_artifact.attempt,
      root,
      result
    )
    expect(
      JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8')).reviewed_snapshot
    ).toEqual(wire.review_artifact.reviewed_snapshot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
