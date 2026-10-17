import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsoleLocalExecutionFixture } from '../console-workflows/console-local-execution-test-fixture'
import { recordConsoleJobResult } from '../runtime/orchestration/console-job-result'
import { ConsoleJobJournal } from '../runtime/orchestration/console-job-journal'
import { getConsoleJobBindingForDispatch } from '../runtime/orchestration/console-job-binding'
import { readConsoleWorkflowEventPage } from './console-workflow-event-page'
import { consoleResultReceiptFingerprint } from './console-workflow-result-publication'
import {
  readSessionOutcomeWorkflowResult,
  readSessionOutcomeWorkflowFailure
} from './session-outcome-workflow-result'
import type { ConsoleWorkflowJob, ConsoleWorkflowJson } from '../../shared/console-workflow-types'
import type { ConsoleJobResultPublication } from '../runtime/orchestration/console-job-result'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'

vi.mock('./console-workflow-event-page', () => ({ readConsoleWorkflowEventPage: vi.fn() }))
const fixtures: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.db.close()
    await rm(f.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
async function fixture(
  status: 'done' | 'failed' = 'done',
  metadata?: Record<string, ConsoleWorkflowJson>
) {
  const f = await createConsoleLocalExecutionFixture({ workspaceKind: 'folder' })
  fixtures.push(f)
  const started = await f.service.start({
    jobId: f.job.id,
    workflowId: f.job.workflowId,
    approvedDigest: f.job.digest,
    worktree: 'id:source'
  })
  if (!started.ok) {
    throw new Error(started.error.message)
  }
  f.service.dispose()
  const activation: SessionOutcomeWorkflow['activations'][number] = {
    jobId: f.job.id,
    state: 'started',
    dispatchId: started.data.dispatchId!,
    runId: started.data.runId
  }
  const binding = getConsoleJobBindingForDispatch(f.db, activation.dispatchId!)!
  const principal = f.db.getRun(activation.runId!)!.console_job_principal!
  const seal = {
    workflow_id: f.job.workflowId,
    revision_id: 'wr_current',
    graph_digest: 'c'.repeat(64)
  }
  const job = {
    id: f.job.id,
    task_id: f.job.taskId,
    provider: f.job.provider,
    model: f.job.model,
    attempt: binding.attempt,
    lease_generation: binding.leaseGeneration,
    status: status === 'done' ? 'done' : 'failed',
    policy: {
      workflow: {
        key: 'build',
        digest: f.job.digest,
        hub_projection: {
          ...seal,
          satisfied: status === 'done',
          verification_report_id: 'report_current'
        }
      }
    }
  } as unknown as ConsoleWorkflowJob
  const result: Record<string, ConsoleWorkflowJson> = {
    status,
    exit_code: status === 'done' ? 0 : 1,
    result_exit_code: status === 'done' ? 0 : 1,
    output_tail: 'Actual fixture report',
    candidate_sha: null,
    branch: null,
    pr_url: null,
    pr_number: null,
    changed_files: [],
    owned_paths_violations: [],
    terminal_proof: { kind: 'test_fixture', exit_code: 0 },
    output_digest: 'e'.repeat(64),
    ...(metadata ? { file_id: 'tfl_snapshot', artifact_sha256: 'd'.repeat(64) } : {})
  }
  const recorded = recordConsoleJobResult(
    f.db,
    { runId: activation.runId!, workerDispatchId: activation.dispatchId!, result },
    (text) => text
  )
  const journal = new ConsoleJobJournal(f.db, (text) => text)
  journal.capture(recorded.observation)
  const row = journal.pending().find((entry) => 'result' in JSON.parse(entry.payload))!
  const payload = JSON.parse(row.payload) as ConsoleJobResultPublication
  const fingerprint = consoleResultReceiptFingerprint(
    {
      ...payload.result,
      attempt: binding.attempt,
      lease_generation: binding.leaseGeneration,
      claimed_at: binding.claim!.claimedAt,
      runner_instance: binding.claim!.runnerInstance,
      input_digest: binding.inputDigest,
      journal_cursor: payload.journalCursor,
      idempotency_key: payload.idempotencyKey
    },
    binding.claim!.host
  )
  const resultDetail = {
    status,
    result_exit_code: result.result_exit_code,
    attempt: binding.attempt,
    lease_generation: binding.leaseGeneration,
    claimed_at: binding.claim!.claimedAt,
    file_id: result.file_id,
    artifact_sha256: result.artifact_sha256,
    candidate_sha: result.candidate_sha,
    pr_url: result.pr_url,
    output_digest: result.output_digest,
    terminal_proof: result.terminal_proof,
    changed_files: result.changed_files,
    owned_paths_violations: result.owned_paths_violations,
    ...metadata
  }
  vi.mocked(readConsoleWorkflowEventPage).mockResolvedValue({
    ok: true,
    data: {
      job_id: job.id,
      next_after: 17,
      events: [
        ...(metadata ? [{ id: 16, job_id: job.id, kind: 'result', detail: resultDetail }] : []),
        {
          id: 17,
          job_id: job.id,
          kind: 'runner_result_receipt',
          detail: {
            claim_id: binding.claim!.claimedAt,
            attempt: binding.attempt,
            host: binding.claim!.host,
            fingerprint
          }
        }
      ]
    }
  } as never)
  return {
    ...f,
    job,
    activation,
    principal,
    seal,
    journal,
    row,
    payload,
    resultDetail,
    acknowledge: () =>
      journal.acknowledge(row, {
        eventId: '17',
        journalCursor: payload.journalCursor,
        idempotencyKey: payload.idempotencyKey
      })
  }
}
it('requires the actual acknowledged native journal publication plus matching server result fingerprint and canonical report', async () => {
  const f = await fixture()
  expect(
    await readSessionOutcomeWorkflowResult(f.runtime, f.job, f.activation, f.principal, f.seal)
  ).toBeNull()
  expect(f.acknowledge()).toBe(true)
  expect(
    await readSessionOutcomeWorkflowResult(f.runtime, f.job, f.activation, f.principal, f.seal)
  ).toMatchObject({
    jobId: f.job.id,
    taskId: f.job.task_id,
    eventId: 17,
    verificationReportId: 'report_current',
    dispatchId: f.activation.dispatchId,
    journalCursor: f.payload.journalCursor,
    idempotencyKey: f.payload.idempotencyKey
  })
})
it.each(['principal', 'fingerprint', 'revision', 'attempt'])(
  'refuses a mismatched %s receipt across the real DB binding',
  async (kind) => {
    const f = await fixture()
    f.acknowledge()
    if (kind === 'fingerprint') {
      vi.mocked(readConsoleWorkflowEventPage).mockResolvedValue({
        ok: true,
        data: { job_id: f.job.id, next_after: 0, events: [] }
      } as never)
    }
    if (kind === 'revision') {
      f.job.policy.workflow.hub_projection!.revision_id = 'wr_stale'
    }
    if (kind === 'attempt') {
      f.job.attempt = 99
    }
    expect(
      await readSessionOutcomeWorkflowResult(
        f.runtime,
        f.job,
        f.activation,
        kind === 'principal' ? 'other' : f.principal,
        f.seal
      )
    ).toBeNull()
  }
)
it('retains a server-acknowledged native failure without manufacturing a passing stage report', async () => {
  const f = await fixture('failed')
  f.acknowledge()
  expect(
    await readSessionOutcomeWorkflowResult(f.runtime, f.job, f.activation, f.principal, f.seal)
  ).toBeNull()
  const failure = await readSessionOutcomeWorkflowFailure(
    f.runtime,
    f.job,
    f.activation,
    f.principal
  )
  expect(failure).toMatchObject({ eventId: 17 })
  expect(failure).not.toHaveProperty('verificationReportId')
})

it('retains only server-authored folder snapshot metadata associated with the exact acknowledged native result', async () => {
  const snapshot = {
    snapshot_digest: 'a'.repeat(64),
    manifest: [{ path: 'report.txt', mode: 0o644, sha256: 'b'.repeat(64), size_bytes: 12 }]
  }
  const f = await fixture('done', { folder_snapshot: snapshot })
  f.acknowledge()
  const receipt = await readSessionOutcomeWorkflowResult(
    f.runtime,
    f.job,
    f.activation,
    f.principal,
    f.seal
  )
  expect(receipt?.folderArtifact).toEqual({
    resultEventId: 16,
    fileId: 'tfl_snapshot',
    sha256: 'd'.repeat(64),
    folderSnapshot: snapshot
  })
  expect(f.payload.result).not.toHaveProperty('folder_snapshot')
})
it.each(['file_id', 'artifact_sha256', 'lease_generation', 'terminal_proof'] as const)(
  'refuses folder metadata from a result with changed %s',
  async (field) => {
    const f = await fixture('done', {
      reviewed_snapshot: {
        schema_version: 1,
        kind: 'current_task_files',
        snapshot_digest: 'a'.repeat(64)
      }
    })
    f.acknowledge()
    Object.assign(f.resultDetail, { [field]: field === 'lease_generation' ? 99 : 'wrong' })
    await expect(
      readSessionOutcomeWorkflowResult(f.runtime, f.job, f.activation, f.principal, f.seal)
    ).rejects.toThrow('does not match this exact acknowledged result')
  }
)
