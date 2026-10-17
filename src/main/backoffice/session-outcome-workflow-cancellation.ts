import { z } from 'zod'
import type {
  OutcomeAmendmentCancellationPort,
  OutcomeAmendmentObservedJob
} from '../../shared/outcome-amendment-cancellation'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow } from './console-workflow-transport'
import { workflowProgress } from './console-workflow-responses'
import { jobId as jobIdSchema } from '../../shared/console-workflow-schemas'
import { getConsoleLocalExecution } from '../console-workflows/console-local-execution-registration'
import { listConsoleLocalExecutions } from '../console-workflows/console-local-execution-state'
import {
  consoleJobProcessIdentity,
  observeConsoleJobProcess
} from '../console-workflows/console-job-process-observation'
import {
  readSessionOutcomeWorkflowResult,
  readSessionOutcomeWorkflowFailure
} from './session-outcome-workflow-result'
import { hasSessionOutcomeCanonicalProjection } from '../runtime/session-outcome-workflow-seal'

const cancelled = z
  .object({
    ok: z.literal(true),
    job: z
      .object({
        id: jobIdSchema,
        status: z.literal('cancelled')
      })
      .passthrough()
  })
  .passthrough()

/** Real signed-server and exact physical-process observations for the shared amendment reconciler. */
export function createSessionOutcomeCancellationPort(
  runtime: OrcaRuntimeService,
  workflows: SessionOutcomeWorkflow[],
  principal: string
): OutcomeAmendmentCancellationPort {
  const observed = new Map<string, OutcomeAmendmentObservedJob>()
  async function assertPerson() {
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok || person.data.principal !== principal) {
      throw new Error('Restore the signed person before amending admitted work.')
    }
    return person.data
  }
  async function readJob(id: string): Promise<OutcomeAmendmentObservedJob> {
    const person = await assertPerson()
    for (const workflow of workflows) {
      const response = await requestConsoleWorkflow(
        `/api/gtd/workflow-graphs/${workflow.preview.workflow_id}`,
        'GET',
        workflowProgress,
        undefined,
        15_000,
        true,
        principal
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const job = response.data.jobs.find((entry) => entry.id === id)
      if (!job) {
        continue
      }
      if (
        !person.isCurrent() ||
        job.policy.workflow.digest !== workflow.preview.digest ||
        response.data.workflow_id !== workflow.preview.workflow_id ||
        !workflow.preview.graph.nodes.some((node) => node.key === job.policy.workflow.key) ||
        (job.policy.workflow.hub_projection &&
          !hasSessionOutcomeCanonicalProjection(
            job.policy.workflow.hub_projection,
            workflow.canonicalSeal
          ))
      ) {
        throw new Error(
          'The cancellation target changed its signed workflow or canonical revision.'
        )
      }
      const records = listConsoleLocalExecutions(runtime.getOrchestrationDb(), principal).filter(
        (record) =>
          record.binding.jobId === id && record.binding.workflowId === workflow.preview.workflow_id
      )
      if (records.length > 1) {
        throw new Error('More than one local process claims this cancellation target.')
      }
      const record = records[0]
      if (
        record &&
        (record.binding.taskId !== job.task_id ||
          record.attempt.job.digest !== workflow.preview.digest ||
          record.binding.attempt !== job.attempt ||
          record.binding.leaseGeneration !== job.lease_generation)
      ) {
        throw new Error(
          'The cancellation target changed its task, attempt or physical execution binding.'
        )
      }
      const physical = record
        ? await observeConsoleJobProcess(runtime, consoleJobProcessIdentity(record))
        : null
      // Zero server attempts plus no persisted native execution is the only no-process shortcut.
      const terminalStopped =
        physical?.state === 'exited' || (!record && !job.attempt && !job.lease_generation)
      const receipt =
        record && workflow.canonicalSeal && terminalStopped
          ? await readSessionOutcomeWorkflowResult(
              runtime,
              job,
              {
                jobId: id,
                state: 'started',
                dispatchId: record.worker.dispatch_id,
                runId: record.run.id
              },
              principal,
              workflow.canonicalSeal
            )
          : null
      const failure =
        record && job.status === 'failed' && terminalStopped
          ? await readSessionOutcomeWorkflowFailure(
              runtime,
              job,
              {
                jobId: id,
                state: 'started',
                dispatchId: record.worker.dispatch_id,
                runId: record.run.id
              },
              principal
            )
          : null
      const state: OutcomeAmendmentObservedJob['state'] = receipt
        ? 'completed'
        : failure
          ? 'failed'
          : job.status === 'cancelled' && terminalStopped
            ? 'cancelled'
            : record && physical?.state !== 'exited'
              ? 'running'
              : job.status === 'queued' && !record && !job.attempt
                ? 'queued'
                : 'unknown'
      const result: OutcomeAmendmentObservedJob = {
        jobId: id,
        workflowId: workflow.preview.workflow_id,
        approvedDigest: workflow.preview.digest,
        taskId: job.task_id,
        state,
        attempt: job.attempt,
        leaseGeneration: job.lease_generation,
        terminalStopped,
        ...(record ? { dispatchId: record.worker.dispatch_id, runId: record.run.id } : {}),
        serverCancellationAcknowledged: job.status === 'cancelled',
        acceptedFailure: failure
          ? { resultReceiptId: String(failure.eventId), resultFingerprint: failure.fingerprint }
          : null,
        acceptedCompletion: receipt
          ? {
              resultReceiptId: String(receipt.eventId),
              resultFingerprint: receipt.fingerprint,
              verificationReportId: receipt.verificationReportId
            }
          : null
      }
      if (!person.isCurrent()) {
        throw new Error('The signed person changed during cancellation readback.')
      }
      observed.set(id, result)
      return result
    }
    throw new Error('The cancellation target is absent from the retained admitted workflows.')
  }
  async function cancelRunning(target: OutcomeAmendmentObservedJob) {
    await assertPerson()
    const latest = await readJob(target.jobId)
    if (latest.state === 'cancelled' || latest.state === 'completed') {
      return
    }
    if (
      !target.dispatchId ||
      !target.runId ||
      latest.dispatchId !== target.dispatchId ||
      latest.runId !== target.runId ||
      latest.attempt !== target.attempt ||
      latest.leaseGeneration !== target.leaseGeneration
    ) {
      throw new Error('The bound cancellation process changed before stop.')
    }
    const result = await getConsoleLocalExecution(runtime).cancel({ jobId: target.jobId })
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    if (
      result.data.dispatchId !== target.dispatchId ||
      result.data.runId !== target.runId ||
      result.data.jobId !== target.jobId ||
      result.data.workflowId !== target.workflowId
    ) {
      throw new Error('The stop acknowledgement belongs to another process.')
    }
  }
  return {
    readJob,
    cancelRunning,
    now: Date.now,
    async cancelQueued(id) {
      await assertPerson()
      const known = observed.get(id)
      if (!known) {
        throw new Error('Read the exact cancellation target before cancelling.')
      }
      const response = await requestConsoleWorkflow(
        `/api/gtd/workflow-jobs/${id}/cancel`,
        'POST',
        cancelled,
        {},
        15_000,
        true,
        principal
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      if (response.data.job.id !== id) {
        throw new Error('The cancellation acknowledgement changed the job.')
      }
      const latest = await readJob(id)
      // Admission can race a queued cancellation. Stop only the newly observed exact owned process.
      if (latest.state === 'running') {
        await cancelRunning(latest)
      }
    }
  }
}
