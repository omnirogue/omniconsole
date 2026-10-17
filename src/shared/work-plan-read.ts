import type { SessionChain, SessionChainAgentStep } from './session-chain-types'
import { stripNextOutcomeOutputInstruction } from './next-outcome-compile'
import { sessionFollowUpDisposition } from './session-follow-up-rule'
import type { SessionOutcome, SessionOutcomeCondition } from './session-outcome-types'
import type { WorkPlanRuntimeStep } from './work-plan-runtime-adapter'
import {
  WORK_PLAN_ROLES,
  type WorkPlan,
  type WorkPlanActor,
  type WorkPlanFinishPeople,
  type WorkPlanNode,
  type WorkPlanRole
} from './work-plan-types'

/** A condition the PLAN authored, as against one the finish owns (a delivery, a reply). */
function isPlanDoneWhen(condition: SessionOutcomeCondition): boolean {
  return condition.kind !== 'handoff' && !condition.recipientId
}

/**
 * The people this outcome finishes at, rebuilt from its own record: who, from the handoff
 * step that carries their names, and what it means, from the disposition it was sent with.
 * Absent when the plan finishes at the person who asked for it.
 */
function workPlanFinishPeople(
  chain: SessionChain,
  outcome: SessionOutcome
): WorkPlanFinishPeople | undefined {
  const recipients = outcome.conditions
    .filter((condition) => !isPlanDoneWhen(condition))
    .map((condition) => condition.recipientId)
    .filter((id): id is string => Boolean(id))
  if (!recipients.length) {
    return undefined
  }
  const step = chain.steps.findLast((entry) => entry.kind === 'handoff')
  const named = step?.kind === 'handoff' ? step.handoff.recipients : []
  const people = [...new Set(recipients)].map((id) => ({
    id,
    name: named.find((person) => person.employeeId === id)?.name ?? id
  }))
  const rule = step?.kind === 'handoff' ? step.handoff : undefined
  return {
    people,
    disposition: rule && sessionFollowUpDisposition(rule) === 'feedback' ? 'feedback' : 'ownership',
    ...(rule?.action ? { action: rule.action } : {}),
    receive: {
      files: rule?.includeSummary ?? true,
      transcript: Boolean(rule?.transcriptSource),
      ...(rule?.note ? { note: rule.note } : {}),
      ...(rule?.taskId ? { taskId: rule.taskId } : {}),
      ...(rule?.dueAt ? { dueAt: rule.dueAt } : {}),
      ...(rule?.artifactReview ? { artifact: { ...rule.artifactReview } } : {})
    }
  }
}

function actor(step: SessionChainAgentStep): WorkPlanActor {
  return {
    agent: step.agent,
    ...(step.model ? { model: step.model } : {}),
    ...(step.effort ? { effort: step.effort } : {}),
    ...(step.accountChoiceId ? { accountChoiceId: step.accountChoiceId } : {}),
    ...(step.openrouterCandidates ? { openrouterCandidates: [...step.openrouterCandidates] } : {})
  }
}

export function workPlanFromChain(chain: SessionChain): WorkPlan {
  const outcome = chain.outcomeSet?.outcomes[0]
  if (!outcome || chain.outcomeSet!.outcomes.length !== 1) {
    throw new Error('A work plan requires exactly one Outcome.')
  }
  const all = chain.steps.filter((s): s is WorkPlanRuntimeStep => s.kind !== 'handoff')
  // In the order the plan RUNS them, which is `outcome.stepIds` — not the order the steps happen
  // to sit in the chain. A stage anchored between two queued ones is appended to `chain.steps`
  // (`work-plan-commit.ts`) and takes its place in `stepIds`; reading the plan back from the array
  // put it last again, so the very next commit re-emitted `stepIds` with the stage the person had
  // placed in the middle running at the end. A step this Outcome does not name keeps its place
  // behind the ones it does.
  const rank = (step: WorkPlanRuntimeStep): number => {
    const index = (outcome.stepIds ?? []).indexOf(step.id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const steps = all
    .filter((s) => (s.planVersion ?? 1) === (chain.planVersion ?? 1))
    .map((step, index) => ({ step, index }))
    .sort((left, right) => rank(left.step) - rank(right.step) || left.index - right.index)
    .map((entry) => entry.step)
  const nodeId = (id: string): string => all.find((s) => s.id === id)?.planNodeId ?? id
  const names = (ids: string[]): string[] => [...new Set(ids.map(nodeId))]
  const nodes: WorkPlanNode[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    const id = step.planNodeId ?? step.id
    if (seen.has(id) || step.reviewRepair) {
      continue
    }
    seen.add(id)
    const own = steps.filter((s) => (s.planNodeId ?? s.id) === id && !s.reviewRepair)
    const verdict = step.verdict
      ? {
          ...step.verdict,
          over: step.verdict.kind === 'verify' ? [...step.verdict.over] : names(step.verdict.over)
        }
      : undefined
    const base = {
      id,
      actor: actor(step),
      ...(step.stage ? { stage: step.stage } : {}),
      instruction: stripNextOutcomeOutputInstruction(
        step.prompt,
        chain.workspacePath,
        chain.id,
        step.id
      ),
      readsFrom: names(step.readsFrom ?? []),
      route: step.route,
      ...(verdict ? { verdict } : {})
    }
    if (step.review) {
      nodes.push({
        ...base,
        kind: 'review',
        seats: own.filter((s) => s.review?.round === 1).map(actor),
        loop: step.review.adversarial ? 'adversarial' : 'review',
        maxRounds: step.review.maxRounds,
        stop: 'zero_blockers',
        // Seats record and the round gates (`work-plan-compile.ts`); the authored node is the gate.
        verdict:
          verdict && !step.review.gate
            ? verdict
            : { ...(verdict ?? { kind: 'review', over: base.readsFrom }), consumed: 'gate' }
      })
    } else {
      const role = WORK_PLAN_ROLES.find((role) => role === step.presetId) ?? 'implement'
      nodes.push({
        ...base,
        kind: 'worker',
        role: role as WorkPlanRole,
        count: own.length,
        seats: own.map(actor),
        ...(step.group ? { group: step.group } : {}),
        writes: step.writes,
        ...(step.readsWinnerOf ? { readsWinnerOf: nodeId(step.readsWinnerOf) } : {}),
        ...(step.enabledBy
          ? {
              enabledBy: {
                verdict: nodeId(step.enabledBy.verdict),
                seatsOf: nodeId(step.enabledBy.seatsOf)
              }
            }
          : {}),
        ...(step.onFail ? { onFail: nodeId(step.onFail) } : {})
      })
    }
  }
  const finishWith = workPlanFinishPeople(chain, outcome)
  nodes.push({
    kind: 'finish',
    id: 'finish',
    how: chain.end === 'me' || finishWith ? 'my-review' : 'complete',
    ...(finishWith ? { route: 'human' as const, finishWith } : {})
  })
  return {
    outcome: {
      title: outcome.title,
      outputKind: outcome.outputKind ?? 'work',
      outcomeId: outcome.id,
      revision: outcome.revision,
      ...(outcome.taskRef ? { taskRef: outcome.taskRef.taskId } : {}),
      // A person finish's own obligations — the delivery, and each reviewer's reply — are
      // read back as the FINISH, not as Done When: they are not criteria the plan invented.
      doneWhen: outcome.conditions.filter(isPlanDoneWhen).map((condition) => {
        const evidence =
          condition.kind === 'review'
            ? 'human'
            : condition.kind === 'report'
              ? 'verdict'
              : condition.kind
        if (!['human', 'verdict', 'file', 'command'].includes(evidence)) {
          throw new Error(`Cannot author ${condition.kind} as WorkPlan Done When.`)
        }
        return {
          id: condition.id,
          text: condition.label ?? condition.target,
          evidence: evidence as 'human' | 'verdict' | 'file' | 'command',
          ...(condition.kind === 'file' ? { path: condition.target } : {}),
          ...(condition.verification ? { command: condition.verification } : {})
        }
      })
    },
    nodes
  }
}
