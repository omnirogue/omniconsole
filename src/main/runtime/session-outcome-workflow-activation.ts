import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { assertSessionOutcomePlanningSource } from './session-outcome-workflow-source'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'

export async function activateNextSessionOutcomeStage(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  observedJobs: ConsoleWorkflowJob[],
  current: () => SessionOutcomeWorkflow,
  save: (patch: Partial<SessionOutcomeWorkflow>) => void
): Promise<void> {
  const port = sessionOutcomeWorkflowPort()
  // An unfinished request re-enters only the same signed claim gateway after local Dispatch readback.
  const retryable = new Set(
    current()
      .activations.filter(
        (entry) =>
          !entry.dispatchId &&
          (entry.state === 'requested' || entry.launchDisposition === 'not-started')
      )
      .map((entry) => entry.jobId)
  )
  const activated = new Set(
    current()
      .activations.filter((entry) => !retryable.has(entry.jobId))
      .map((entry) => entry.jobId)
  )
  const next = observedJobs.find(
    (job) =>
      job.actor_type === 'ai' &&
      job.policy.workflow.placement === 'local' &&
      ((job.status === 'queued' && job.workflow_state === 'ready') ||
        (retryable.has(job.id) && job.status === 'running')) &&
      !job.blockers.length &&
      !job.policy.workflow.skipped &&
      !activated.has(job.id)
  )
  if (next && !current().retired) {
    assertSessionOutcomePlanningSource(runtime, chain)
    save({
      activations: [
        ...current().activations.filter((entry) => entry.jobId !== next.id),
        { jobId: next.id, state: 'requested' }
      ],
      error: undefined
    })
    const result = await port.start(runtime, {
      jobId: next.id,
      workflowId: current().preview.workflow_id,
      approvedDigest: current().preview.digest,
      worktree: `id:${chain.worktreeId}`
    })
    save({
      activations: current().activations.map((entry) =>
        entry.jobId !== next.id
          ? entry
          : result.ok && result.data.dispatchId
            ? {
                ...entry,
                state: 'started',
                dispatchId: result.data.dispatchId,
                runId: result.data.runId,
                error: result.data.error,
                launchDisposition: undefined
              }
            : {
                ...entry,
                state: 'unverifiable',
                launchDisposition: result.ok
                  ? 'unverifiable'
                  : (result.error.launchDisposition ?? 'unverifiable'),
                error: result.ok
                  ? 'The admitted job has no verified local Dispatch.'
                  : result.error.message
              }
      )
    })
  }
  const activationError = current().activations.find((entry) => entry.error)?.error
  if (activationError) {
    throw new Error(activationError)
  }
}
