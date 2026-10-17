import {
  readMergedGitHubReview,
  GitHubReviewReadbackError
} from '../console-workflows/console-github-review-readback'
import { reconcileOutcomeAmendment } from '../backoffice/outcome-amendment-reconciliation'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import { blockSessionOutcomes } from './session-outcome-hold-write'

/** Persisted cancellation reconciles before any replacement admission or host effect. */
export async function advanceSessionOutcomeAmendment(
  service: SessionOutcomeService,
  initial: SessionChain
) {
  let chain = initial
  const intent = chain.outcomeSet!.amendment
  if (!intent) {
    return { chain, ready: true }
  }
  const generations = [...(chain.outcomeSet!.workflowHistory ?? []), chain.outcomeSet!.workflow!]
  try {
    for (const operation of chain.outcomeSet!.publications?.filter(
      (entry) => entry.state === 'requested'
    ) ?? []) {
      let observed
      try {
        observed = await readMergedGitHubReview(operation.admission)
      } catch (error) {
        if (error instanceof GitHubReviewReadbackError && error.code === 'not-merged') {
          throw new Error(
            'Waiting for the previous merge request to settle before amended work starts.'
          )
        }
        throw error
      }
      chain = service.save(
        {
          ...chain,
          outcomeSet: {
            ...chain.outcomeSet!,
            publications: chain.outcomeSet!.publications!.map((entry) =>
              entry.id === operation.id
                ? { ...entry, state: 'merged', mergeCommitSha: observed.review.mergeCommitSha! }
                : entry
            )
          }
        },
        chain.outcomeSet!.revision
      )
    }
    const settled =
      intent.state === 'ready'
        ? intent
        : await reconcileOutcomeAmendment(
            sessionOutcomeWorkflowPort().cancellation(
              service.runtime,
              generations,
              intent.principal
            ),
            intent,
            async (amendment) => {
              chain = service.save(
                { ...chain, outcomeSet: { ...chain.outcomeSet!, amendment } },
                chain.outcomeSet!.revision
              )
            }
          )
    if (settled.state === 'blocked') {
      throw new Error(
        settled.jobs.find((job) => job.error)?.error ??
          'The saved amendment requires reconciliation before work can continue.'
      )
    }
    if (settled.state !== 'ready') {
      return { chain, ready: false }
    }
    const retire = (workflow: (typeof generations)[number]) =>
      settled.sourceOperationIds.includes(workflow.operationId)
        ? { ...workflow, retired: true }
        : workflow
    chain = service.save(
      {
        ...chain,
        outcomeSet: {
          ...chain.outcomeSet!,
          workflow: retire(chain.outcomeSet!.workflow!),
          workflowHistory: chain.outcomeSet!.workflowHistory?.map(retire)
        }
      },
      chain.outcomeSet!.revision
    )
    return { chain, ready: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const affected = new Set(
      generations
        .filter(
          (workflow) =>
            workflow.operationId === chain.outcomeSet!.workflow!.operationId ||
            intent.sourceOperationIds.includes(workflow.operationId)
        )
        .flatMap((workflow) => workflow.stages.flatMap((stage) => stage.outcomeIds))
    )
    chain = service.save(
      {
        ...chain,
        outcomeSet: blockSessionOutcomes(
          chain.outcomeSet!,
          (outcome) => affected.has(outcome.id) && outcome.status !== 'satisfied',
          reason,
          // The amendment is attempted again on the next tick; one that never lands goes stale.
          { class: 'recovering', code: 'workflow-amendment' },
          Date.now()
        )
      },
      chain.outcomeSet!.revision
    )
    return { chain, ready: false }
  }
}
