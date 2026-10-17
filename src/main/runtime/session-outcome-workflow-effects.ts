import { currentSessionOutcomeWorkflowOutcomeIds } from './session-outcome-workflow-relevance'
import { sessionOutcomeActionKey } from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'
import { verifySessionOutcomeCondition } from './session-outcome-evidence'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
import {
  executeSessionOutcomeHandoff,
  sessionOutcomeHandoffBlocker
} from './session-outcome-handoff'
import { publishSessionOutcomeMerge } from './session-outcome-workflow-publication'
import type { SessionOutcomeService } from './session-outcome-service'
import { sessionOutcomeWorkflowTarget } from './session-outcome-workflow-target'
import { materializeSessionOutcomeGitDeliverables } from './session-outcome-git-deliverables'
import { HandoffDeliverablesMissing } from './session-handoff-capture'
import { decideSessionOutcomeHandoffRecovery } from './session-outcome-handoff-recovery'
import { blockSessionOutcomes, holdSessionOutcome } from './session-outcome-hold-write'

/** Existing host publication and delivery run only after all admitted predecessor work is verified. */
export async function advanceSessionOutcomeWorkflowEffects(
  service: SessionOutcomeService,
  initial: SessionChain
): Promise<void> {
  let chain = initial
  const save = (next: SessionChain): void => {
    chain = service.save(next, chain.outcomeSet!.revision)
  }
  for (const original of chain.outcomeSet!.outcomes) {
    let outcome = chain.outcomeSet!.outcomes.find((entry) => entry.id === original.id)!
    if (outcome.status === 'satisfied') {
      continue
    }
    const scope = new Set([outcome.id])
    for (const id of scope) {
      for (const dependency of chain.outcomeSet!.outcomes.find((entry) => entry.id === id)
        ?.dependsOn ?? []) {
        scope.add(dependency)
      }
    }
    const unverified = [
      ...(chain.outcomeSet!.workflowHistory ?? []),
      chain.outcomeSet!.workflow!
    ].find(
      (workflow) =>
        workflow.error &&
        [...currentSessionOutcomeWorkflowOutcomeIds(chain, workflow)].some((id) => scope.has(id))
    )
    if (unverified) {
      continue
    }
    try {
      const ownedSteps = chain.steps.filter((step) => outcome.stepIds?.includes(step.id))
      const agentsComplete = ownedSteps
        .filter((step) => step.kind !== 'handoff')
        .every((step) => chain.outcomeSet!.completedSteps?.includes(step.id))
      if (!agentsComplete) {
        continue
      }
      for (const step of ownedSteps) {
        const held =
          step.kind === 'handoff' && !chain.outcomeSet!.completedSteps?.includes(step.id)
            ? sessionOutcomeHandoffBlocker(step)
            : undefined
        if (held) {
          throw new Error(held)
        }
      }
      if (
        !outcome.actions.every((action) =>
          chain.outcomeSet!.attempts.some(
            (attempt) =>
              attempt.outcomeId === outcome.id &&
              attempt.actionId === action.id &&
              attempt.actionKey === sessionOutcomeActionKey(action) &&
              attempt.state === 'completed'
          )
        )
      ) {
        continue
      }
      for (const step of ownedSteps) {
        if (step.kind !== 'handoff' || chain.outcomeSet!.completedSteps?.includes(step.id)) {
          continue
        }
        const workflows = [
          ...(chain.outcomeSet!.workflowHistory ?? []),
          chain.outcomeSet!.workflow!
        ]
        const hasGitCandidate = workflows.some((workflow) =>
          workflow.stages.some(
            (stage) =>
              stage.outcomeIds.some((id) => scope.has(id)) &&
              workflow.closedStages?.some((closed) => closed.key === stage.key) &&
              workflow.receipts?.some(
                (receipt) => receipt.key === stage.key && Boolean(receipt.candidateSha)
              )
          )
        )
        if (hasGitCandidate) {
          const handoffCondition = outcome.conditions.find(
            (entry) => entry.kind === 'handoff' || entry.kind === 'review'
          )
          if (!handoffCondition) {
            throw new Error('The human handoff outcome has no saved delivery condition.')
          }
          const candidate = sessionOutcomeWorkflowTarget(chain, handoffCondition, outcome.id)
          await materializeSessionOutcomeGitDeliverables({
            workspacePath: chain.workspacePath,
            candidateSha: candidate.receipt.candidateSha!,
            handoff: step.handoff
          })
        }
      }
      if (
        !outcome.dependsOn.every(
          (id) =>
            chain.outcomeSet!.outcomes.find((entry) => entry.id === id)?.status === 'satisfied'
        )
      ) {
        continue
      }
      if (outcome.finish === 'merge') {
        chain = await publishSessionOutcomeMerge(service, chain, outcome.id)
      }
      for (const step of ownedSteps) {
        if (step.kind !== 'handoff' || chain.outcomeSet!.completedSteps?.includes(step.id)) {
          continue
        }
        if (step.handoff.taskId !== chain.outcomeSet!.continuation.taskId) {
          throw new Error('The handoff must remain on the original task.')
        }
        for (const prerequisite of outcome.conditions.filter(
          (entry) => entry.kind !== 'handoff' && entry.kind !== 'review'
        )) {
          const proof = await verifySessionOutcomeCondition(
            prerequisite,
            chain.workspacePath,
            service.runtime,
            chain,
            outcome.id
          )
          if (!proof.verified) {
            throw new Error(proof.reason)
          }
        }
        const workflowReceipts = [
          ...(chain.outcomeSet!.workflowHistory ?? []),
          chain.outcomeSet!.workflow!
        ].flatMap((workflow) => workflow.receipts ?? [])
        const summary = JSON.stringify(
          {
            originalTaskId: chain.outcomeSet!.continuation.taskId,
            acceptedStages: workflowReceipts,
            publications: chain.outcomeSet!.publications ?? [],
            requestedOutcomes: chain.outcomeSet!.outcomes.map((entry) => ({
              id: entry.id,
              title: entry.title,
              finish: entry.finish
            }))
          },
          null,
          2
        )
        await executeSessionOutcomeHandoff({ chain, step, summary, read: () => chain, save })
        save({
          ...chain,
          outcomeSet: {
            ...chain.outcomeSet!,
            completedSteps: [...new Set([...(chain.outcomeSet!.completedSteps ?? []), step.id])]
          }
        })
      }
      outcome = chain.outcomeSet!.outcomes.find((entry) => entry.id === outcome.id)!
      const verified = await verifySessionOutcomeProgress(service.runtime, chain, outcome)
      const nextIndex = chain.steps.findIndex(
        (step) => !verified.set.completedSteps?.includes(step.id)
      )
      const unproven =
        verified.set.outcomes.find((entry) => entry.id === outcome.id)!.status !== 'satisfied'
      save({
        ...chain,
        currentIndex: nextIndex === -1 ? chain.steps.length : nextIndex,
        outcomeSet:
          unproven && verified.reason
            ? holdSessionOutcome(
                chain,
                verified.set,
                outcome.id,
                { kind: 'verification', reason: verified.reason },
                Date.now()
              )
            : {
                ...verified.set,
                outcomes: verified.set.outcomes.map((entry) => {
                  if (entry.id !== outcome.id || entry.status === 'satisfied') {
                    return entry
                  }
                  const { block: _lifted, ...rest } = entry
                  return { ...rest, status: 'pending' as const, blockedReason: undefined }
                })
              }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const now = Date.now()
      // A delivery that did not go out is classified from the rule that carries its failure; any
      // other effect is simply run again by the next tick, and goes stale if it never clears.
      const heldStep = chain.steps.find(
        (step) =>
          step.kind === 'handoff' &&
          outcome.stepIds?.includes(step.id) &&
          !chain.outcomeSet!.completedSteps?.includes(step.id) &&
          (error instanceof HandoffDeliverablesMissing ||
            decideSessionOutcomeHandoffRecovery(step.handoff, now).kind !== 'none')
      )
      save({
        ...chain,
        outcomeSet: heldStep
          ? holdSessionOutcome(
              chain,
              chain.outcomeSet!,
              outcome.id,
              { kind: 'handoff', stepId: heldStep.id, reason },
              now
            )
          : blockSessionOutcomes(
              chain.outcomeSet!,
              (entry) => entry.id === outcome.id,
              reason,
              { class: 'recovering', code: 'workflow-effect' },
              now
            )
      })
    }
  }
}
