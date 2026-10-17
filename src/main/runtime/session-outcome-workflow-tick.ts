import { currentSessionOutcomeWorkflowOutcomeIds } from './session-outcome-workflow-relevance'
import { advanceSessionOutcomeAmendment } from './session-outcome-workflow-amendment-tick'
import {
  readSessionOutcomeCanonicalSeal,
  hasSessionOutcomeCanonicalProjection
} from './session-outcome-workflow-seal'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { projectSessionOutcomeStageCompletion } from './session-outcome-workflow-completion'
import { advanceSessionOutcomeWorkflowEffects } from './session-outcome-workflow-effects'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import { resolveSessionOutcomeSourceReadiness } from './session-outcome-source-readiness'
import { activateNextSessionOutcomeStage } from './session-outcome-workflow-activation'
import { blockSessionOutcomes } from './session-outcome-hold-write'

/** Reuses server admission and named local activation. No local dependency, loop or acceptance decisions. */
export async function advanceSessionOutcomeWorkflow(
  service: SessionOutcomeService,
  initial: SessionChain
): Promise<void> {
  const amended = await advanceSessionOutcomeAmendment(service, initial)
  if (!amended.ready) {
    return
  }
  initial = amended.chain
  const generations = [
    ...(initial.outcomeSet!.workflowHistory ?? []),
    initial.outcomeSet!.workflow!
  ]
  for (const generation of generations) {
    await advanceGeneration(service, service.get(initial.id), generation.operationId)
  }
  await advanceSessionOutcomeWorkflowEffects(service, service.get(initial.id))
}
async function advanceGeneration(
  service: SessionOutcomeService,
  initial: SessionChain,
  operationId: string
): Promise<void> {
  let chain = initial
  const current = () =>
    [...(chain.outcomeSet!.workflowHistory ?? []), chain.outcomeSet!.workflow!].find(
      (entry) => entry.operationId === operationId
    )!
  const save = (patch: Partial<NonNullable<SessionChain['outcomeSet']>['workflow']>): void => {
    const set = chain.outcomeSet!
    chain = service.save(
      {
        ...chain,
        outcomeSet: {
          ...set,
          ...(set.workflow!.operationId === operationId
            ? { workflow: { ...set.workflow!, ...patch } }
            : {
                workflowHistory: set.workflowHistory!.map((entry) =>
                  entry.operationId === operationId ? { ...entry, ...patch } : entry
                )
              })
        }
      },
      set.revision
    )
  }
  const port = sessionOutcomeWorkflowPort()
  try {
    let set = chain.outcomeSet!
    let workflow = current()
    // Re-observe before the first activation too: a stored `true` must never be the only
    // evidence that the source finished, and a fresh version pins what reviewers will read.
    if (!set.continuation.sourceReady || !workflow.activations.length) {
      const source = await resolveSessionOutcomeSourceReadiness(service.runtime, chain)
      if (!source.ready) {
        save({ error: source.reason ?? 'Waiting for the original admitted source to finish.' })
        return
      }
      if (!set.continuation.sourceReady || source.version !== set.continuation.sourceVersion) {
        chain = service.save(
          {
            ...chain,
            outcomeSet: {
              ...set,
              continuation: {
                ...set.continuation,
                sourceReady: true,
                ...(source.version ? { sourceVersion: source.version } : {})
              }
            }
          },
          set.revision
        )
        set = chain.outcomeSet!
      }
    }
    if (
      workflow.prerequisiteOutcomeIds?.some(
        (id) => set.outcomes.find((outcome) => outcome.id === id)?.status !== 'satisfied'
      )
    ) {
      save({ error: 'Waiting for the verified prerequisite outcomes from the earlier workflow.' })
      return
    }
    if (workflow.retired && workflow.phase !== 'admitted') {
      return
    }
    if (workflow.phase !== 'admitted') {
      save({ phase: 'admitting', error: undefined })
      const admission = await port.admit(workflow.preview, set.continuation.principal!)
      if (!admission.ok) {
        throw new Error(admission.error.message)
      }
      if (admission.data.workflow_id !== workflow.preview.workflow_id) {
        throw new Error('Admission changed the reviewed workflow identity.')
      }
      const canonicalSeal = readSessionOutcomeCanonicalSeal(
        admission.data.receipt,
        workflow.preview.workflow_id
      )
      save({ phase: 'admitted', canonicalSeal })
    }
    workflow = current()
    const observed = await port.observe(workflow.preview.workflow_id, set.continuation.principal!)
    if (!observed.ok) {
      throw new Error(observed.error.message)
    }
    if (
      observed.data.workflow_id !== workflow.preview.workflow_id ||
      observed.data.jobs.some(
        (job) =>
          job.policy.workflow.digest !== workflow.preview.digest ||
          !workflow.preview.graph.nodes.some((node) => node.key === job.policy.workflow.key)
      )
    ) {
      throw new Error('The workflow projection does not match the immutable reviewed graph.')
    }
    for (const job of observed.data.jobs) {
      const node = workflow.preview.graph.nodes.find(
        (entry) => entry.key === job.policy.workflow.key
      )!
      if (
        job.task_id === set.continuation.taskId ||
        job.actor_type !== node.actor_type ||
        job.policy.workflow.action !== node.action ||
        (job.provider ?? null) !== (node.provider ?? null) ||
        (job.model ?? null) !== (node.model ?? null)
      ) {
        throw new Error('The admitted stage changed its child task, actor or exact model.')
      }
    }
    if (!workflow.canonicalSeal) {
      throw new Error('The admitted workflow has no canonical revision seal.')
    }
    for (const job of observed.data.jobs) {
      if (
        job.policy.workflow.hub_projection &&
        !hasSessionOutcomeCanonicalProjection(
          job.policy.workflow.hub_projection,
          workflow.canonicalSeal
        )
      ) {
        throw new Error('The stage projection changed its admitted canonical revision.')
      }
    }
    const local = await port.list(service.runtime)
    if (!local.ok) {
      throw new Error(local.error.message)
    }
    for (const activation of workflow.activations) {
      const actual = local.data.find(
        (entry) =>
          entry.jobId === activation.jobId && entry.workflowId === workflow.preview.workflow_id
      )
      if (
        actual?.dispatchId &&
        (activation.dispatchId !== actual.dispatchId ||
          activation.state !== 'started' ||
          activation.error !== actual.error)
      ) {
        save({
          activations: current().activations.map((entry) =>
            entry.jobId === activation.jobId
              ? {
                  ...entry,
                  state: 'started',
                  dispatchId: actual.dispatchId!,
                  runId: actual.runId,
                  error: actual.error,
                  launchDisposition: undefined
                }
              : entry
          )
        })
      }
    }
    for (const activation of current().activations) {
      const job = observed.data.jobs.find((entry) => entry.id === activation.jobId)
      if (!job || activation.state !== 'started') {
        continue
      }
      const receipt = await port.receipt(
        service.runtime,
        job,
        activation,
        set.continuation.principal!,
        workflow.canonicalSeal
      )
      if (!receipt) {
        continue
      }
      const prior = current().receipts?.find(
        (entry) => entry.jobId === receipt.jobId && entry.attempt === receipt.attempt
      )
      if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) {
        throw new Error('The accepted stage receipt changed after it was frozen.')
      }
      if (!prior) {
        save({ receipts: [...(current().receipts ?? []), receipt] })
      }
    }
    save({ error: undefined })
    const closed = closedSessionOutcomeStages(
      current(),
      observed.data.jobs,
      chain.outcomeSet!.workflowHistory ?? []
    )
    save({
      closedStages: closed.map((entry) => ({
        key: entry.key,
        reviewJobIds: entry.reviews.map((receipt) => receipt.jobId),
        producerJobId: entry.producer?.jobId,
        round: entry.round,
        verificationReportId: entry.verificationReportId,
        evidenceId: entry.evidenceId
      }))
    })
    chain = projectSessionOutcomeStageCompletion(
      service,
      chain,
      current(),
      closed,
      observed.data.jobs
    )
    await activateNextSessionOutcomeStage(service.runtime, chain, observed.data.jobs, current, save)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    save({ error: reason, verifiedProducerReceipts: [] })
    const affected = currentSessionOutcomeWorkflowOutcomeIds(chain, current())
    chain = service.save(
      {
        ...chain,
        outcomeSet: blockSessionOutcomes(
          chain.outcomeSet!,
          (outcome) => affected.has(outcome.id) && outcome.status !== 'satisfied',
          reason,
          // The hub is observed again on the next tick; an error that never clears goes stale.
          { class: 'recovering', code: 'workflow-error' },
          Date.now()
        )
      },
      chain.outcomeSet!.revision
    )
  }
}
