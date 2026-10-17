import { captureConsoleOmpSession, readConsoleOmpExecution } from '../omp/omp-execution-receipt'
import type { OrchestrationCheckOutput } from '../../shared/orchestration-check-output'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { OrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import type { ConsoleLocalExecutionRecord } from './console-local-execution-state'
import type {
  ConsoleLocalExecutionPort,
  ConsoleLocalResult
} from './console-local-execution-contract'
import { consoleJobOutputDigest, runConsoleJobAcceptance } from './console-job-acceptance'
import { publishConsoleJobReview } from './console-job-review'
import type { ConsoleJobResultGate } from './console-job-result-gate'
import { finishConsoleJobProcess } from './console-job-process-observation'
import { extractConsoleJobFindings } from './console-job-findings'
import { resolveConsoleFolderJobWorkspace } from './console-folder-job-workspace'
import { recordConsoleFolderJobResult } from './console-folder-job-result'
import { publishConsoleJobArtifact } from './console-job-artifact-publication'
import {
  consoleLoopVerdictFailure,
  consoleLoopVerdictRequired,
  readConsoleLoopVerdict
} from './console-loop-verdict'

export type ConsoleResultJournal = {
  read(dispatchId: string): ConsoleLocalResult | null
  record(record: ConsoleLocalExecutionRecord, result: ConsoleLocalResult): void
  flush(): Promise<void>
}
export type ConsoleJobMonitorContext = {
  runtime: OrcaRuntimeService
  call: OrchestrationCaller
  port: ConsoleLocalExecutionPort
  results: ConsoleResultJournal
  resultGate: ConsoleJobResultGate
  cancel: (jobId: string) => Promise<unknown>
}

export async function monitorConsoleJob(
  ctx: ConsoleJobMonitorContext,
  record: ConsoleLocalExecutionRecord,
  signal: AbortSignal
): Promise<void> {
  if (ctx.results.read(record.worker.dispatch_id)) {
    await ctx.results.flush()
    return
  }
  let pendingAck: string | null = null
  const coordinator = record.run.coordinator_handle
  if (!coordinator) {
    throw new Error('The committed execution has no coordinator handle; its state is unverifiable.')
  }
  while (!signal.aborted) {
    if ((await ctx.port.principal()) !== record.run.console_job_principal) {
      return
    }
    const status = await ctx.port.inspect(record.binding, record.run.console_job_principal!)
    if (!status.ok) {
      throw new Error(status.error.message)
    }
    if (status.data.cancelled) {
      await ctx.cancel(record.binding.jobId)
      return
    }
    const worker = ctx.runtime.getOrchestrationDb().getWorkerDispatch(record.worker.dispatch_id)
    if (worker && ['succeeded', 'failed'].includes(worker.state)) {
      await ctx.resultGate.run(worker.dispatch_id, async () => {
        if (!signal.aborted) {
          await finalizeConsoleJob(ctx, record, worker.state === 'succeeded', signal)
        }
      })
      if (signal.aborted) {
        return
      }
      await ctx.call('orchestration.workerRelease', { dispatch: worker.dispatch_id })
      if (pendingAck) {
        await ctx.call('orchestration.check', {
          terminal: coordinator,
          run: record.run.id,
          ack: pendingAck,
          peek: true
        })
      }
      return
    }
    const shown = await ctx.call<{ observation: { status: string }; worker: { state: string } }>(
      'orchestration.workerShow',
      { dispatch: record.worker.dispatch_id }
    )
    if (shown.observation.status === 'unverifiable' || shown.worker.state === 'stop_unknown') {
      throw new Error('The execution host cannot verify this Dispatch; its state is unverifiable.')
    }
    if (shown.observation.status === 'exited') {
      throw new Error('The worker exited without a settled result; the job needs review.')
    }
    const delivery = await ctx.call<OrchestrationCheckOutput>(
      'orchestration.check',
      {
        terminal: coordinator,
        run: record.run.id,
        wait: true,
        timeoutMs: 30_000,
        types: 'worker_done,heartbeat,status,escalation,question',
        ...(pendingAck ? { ack: pendingAck } : {})
      },
      { signal }
    )
    pendingAck = delivery.deliveryId ?? null
    if (delivery.connectionLost) {
      throw new Error('Contact with the execution host was lost; its state is unverifiable.')
    }
    for (const message of delivery.messages) {
      const row = ctx.runtime
        .getOrchestrationDb()
        .db.prepare('SELECT sequence FROM messages WHERE id = ? AND run_id = ?')
        .get(message.id, record.run.id) as { sequence: number } | undefined
      if (!row) {
        continue
      }
      ctx.runtime.recordOrchestrationExecutionObservation({
        runId: record.run.id,
        event: 'checkpoint_written',
        workerDispatchId: record.worker.dispatch_id,
        checkpointCursor: `orchestration:${record.run.id}:messages:${row.sequence}`,
        detail: ctx.port.sanitize(message.body ?? message.subject ?? message.type ?? 'Checkpoint')
      })
    }
  }
}

/** A required verdict that cannot be read (file absent, malformed, or no admitted directory) is a recorded failure. */
async function withConsoleLoopVerdict(
  ctx: ConsoleJobMonitorContext,
  record: ConsoleLocalExecutionRecord,
  result: ConsoleLocalResult
): Promise<ConsoleLocalResult> {
  const { job, worktreePath } = record.attempt
  const loopVerdict = await readConsoleLoopVerdict(job, worktreePath)
  if (loopVerdict) {
    return { ...result, workflow_loop_verdict: loopVerdict }
  }
  if (!consoleLoopVerdictRequired(job)) {
    return result
  }
  return {
    ...result,
    status: 'failed',
    output_tail: ctx.port
      .sanitize(`${result.output_tail}\n${consoleLoopVerdictFailure(job)}`)
      .slice(-16_000)
  }
}

async function finalizeConsoleJob(
  ctx: ConsoleJobMonitorContext,
  record: ConsoleLocalExecutionRecord,
  succeeded: boolean,
  signal: AbortSignal
): Promise<void> {
  if (ctx.results.read(record.worker.dispatch_id)) {
    await ctx.results.flush()
    return
  }
  const session = succeeded ? captureConsoleOmpSession(ctx.runtime, record) : null
  const proof = await finishConsoleJobProcess(ctx.runtime, record)
  if (signal.aborted) {
    return
  }
  const execution = succeeded
    ? await readConsoleOmpExecution(
        ctx.runtime,
        record,
        Date.parse(proof.process_identity.started_at),
        session
      )
    : undefined
  const { attempt } = record
  const findings = extractConsoleJobFindings(
    ctx.runtime.getOrchestrationDb(),
    record.worker.dispatch_id,
    ctx.port.sanitize
  )
  if (
    (attempt.job.action === 'review' ||
      attempt.job.workspace?.kind === 'folder' ||
      attempt.job.artifactResult) &&
    !findings
  ) {
    throw new Error('The worker did not commit its exact findings report.')
  }
  if (attempt.job.workspace?.kind === 'folder') {
    const current = await resolveConsoleFolderJobWorkspace(
      ctx.runtime,
      `id:${attempt.worktreeId}`,
      attempt.job
    )
    if (current.path !== attempt.worktreePath) {
      throw new Error('The attempt folder identity changed; no result was published.')
    }
    if (!signal.aborted) {
      let result = recordConsoleFolderJobResult({
        job: attempt.job,
        workerSucceeded: succeeded,
        proof,
        findings: findings!,
        sanitize: ctx.port.sanitize
      })
      result = await withConsoleLoopVerdict(ctx, record, {
        ...result,
        ...(execution ? { execution } : {})
      })
      result.output_digest = consoleJobOutputDigest(result)
      const published = await publishConsoleJobArtifact(ctx, record, result, signal)
      if (!published) {
        return
      }
      result = published
      ctx.results.record(record, result)
      await ctx.results.flush()
    }
    return
  }
  if (!attempt.attemptStartSha || !attempt.branch) {
    throw new Error('The Git attempt is missing its original commit or branch.')
  }
  const current = await ctx.runtime.showManagedTerminalWorkspace(`id:${attempt.worktreeId}`)
  if (current.git.path !== attempt.worktreePath || (current.hostId && current.hostId !== 'local')) {
    throw new Error(
      'The attempt workspace identity changed; no acceptance or publication was attempted.'
    )
  }
  let result = await runConsoleJobAcceptance({
    job: attempt.job,
    cwd: attempt.worktreePath,
    startSha: attempt.attemptStartSha,
    branch: attempt.branch,
    workerSucceeded: succeeded,
    processProof: proof,
    sanitize: ctx.port.sanitize,
    signal
  })
  if (signal.aborted) {
    return
  }
  result = await withConsoleLoopVerdict(ctx, record, {
    ...result,
    ...(execution ? { execution } : {}),
    ...findings,
    ...(attempt.job.action === 'review' && findings ? { review_text: findings.worker_report } : {}),
    terminal_proof: proof
  })
  result.output_digest = consoleJobOutputDigest(result)
  if (attempt.job.artifactResult) {
    const published = await publishConsoleJobArtifact(ctx, record, result, signal)
    if (published) {
      ctx.results.record(record, published)
      await ctx.results.flush()
    }
    return
  }
  try {
    result = await publishConsoleJobReview(attempt.job, attempt.worktreePath, result)
  } catch (error) {
    result = {
      ...result,
      status: 'failed',
      output_tail: ctx.port
        .sanitize(
          `${result.output_tail}\n${error instanceof Error ? error.message : 'Review publication was not confirmed.'}`
        )
        .slice(-16_000)
    }
  }
  result.output_digest = consoleJobOutputDigest(result)
  ctx.results.record(record, result)
  await ctx.results.flush()
}
