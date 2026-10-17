import type { SessionChain, SessionChainStep } from './session-chain-types'
import type { SessionChainHandoffStep } from './session-follow-up-rule'
import type { SessionFollowUpTranscriptSource } from './session-follow-up-transcript'
import type { SessionOutcomeCommit } from './session-outcome-types'
import { compileWorkPlanExecution, type WorkPlanCompileContext } from './work-plan-compile'
import {
  remapWorkPlanStepIds,
  workPlanDanglingReferences,
  workPlanSameSeat
} from './work-plan-revision'
import type { WorkPlanRuntimeStep } from './work-plan-runtime-adapter'
import type { WorkPlan, WorkPlanProblem } from './work-plan-types'
import { workPlanOutcomeOf } from './work-plan-types'

export type WorkPlanCommitRequest = SessionOutcomeCommit & { chain: SessionChain }

/**
 * What this commit does to the plan the chain already carries.
 *
 * `supersede` REPLACES it: another strategy toward the same Outcome, so the work the old plan
 * had not finished is retired and the plan version advances. `append` only ADDS behind it — a
 * second `+ Agent` after a stage that is queued or already running — so nothing is retired,
 * no node is re-planned, and the version does NOT move: the new stages join the version that
 * is running. That is what makes an append additive rather than a re-plan, and why it is
 * allowed while work is in flight: the frozen model's rule 7 says work in flight cannot be
 * re-planned, only followed by more.
 */
export type WorkPlanCommitMode = 'supersede' | 'append'

export type WorkPlanCommitContext = WorkPlanCompileContext & {
  /** The surface resolves the execution owner; shared code never guesses a local workspace. */
  chain: SessionChain
  /** Inject next-step-outcome-client.commitSessionOutcomes (CLI supplies the same RPC door). */
  commitSessionOutcomes: (args: WorkPlanCommitRequest) => Promise<SessionChain>
  supersedeReason?: string
  /** Absent means `supersede`, which is what changing strategy has always done. */
  mode?: WorkPlanCommitMode
  /**
   * Where the people who receive this work can read the conversation, when the plan asked for
   * the transcript. Only the surface can name it (`getSessionOutcomeTranscriptSource`), so the
   * rule carries it from here rather than being invented by shared code.
   */
  transcriptSource?: SessionFollowUpTranscriptSource
}

/**
 * The steps of this outcome, in the order the PLAN runs them.
 *
 * The host's barrier takes the first incomplete step of `outcome.stepIds`
 * (`advanceSessionOutcomeSteps`), so this list — not the order the steps happened to be
 * compiled in — is what decides what runs next. A stage the person anchored between two
 * queued stages therefore runs where it was shown. Every step the chain carries is named,
 * the person handoff an earlier version already sent included: a step no outcome owns is
 * refused by the host.
 */
function orderedStepIds(plan: WorkPlan, steps: readonly SessionChainStep[]): string[] {
  const order = plan.nodes.map((node) => node.id)
  const rank = (step: SessionChainStep): number => {
    // The people ARE the plan's finish, so a handoff sorts last; so does a step whose node
    // this plan no longer draws, which keeps its place instead of jumping the queue.
    const node = step.kind === 'handoff' ? undefined : (step.planNodeId ?? step.id)
    const index = node ? order.indexOf(node) : -1
    return index === -1 ? order.length : index
  }
  return [
    ...new Set(
      steps
        .map((step, index) => ({ step, index }))
        .sort((left, right) => rank(left.step) - rank(right.step) || left.index - right.index)
        .map((entry) => entry.step.id)
    )
  ]
}

/**
 * A second ask, to DIFFERENT people, as its own step.
 *
 * The compiler names a plan's person handoff after the OUTCOME — one plan finishes at one set
 * of people — so a chain that asks again compiles the id the first ask already has, and a
 * chain never reuses an id. The new ask is named after the people it asks, which is what makes
 * it addressable: a second review has its own step, its own receipts and its own gate.
 */
function freshHandoffIds(
  handoffs: readonly SessionChainHandoffStep[],
  existing: SessionChain | undefined
): SessionChainHandoffStep[] {
  const taken = new Set((existing?.steps ?? []).map((step) => step.id))
  return handoffs.map((step) => {
    if (!taken.has(step.id)) {
      taken.add(step.id)
      return step
    }
    const asked = step.handoff.recipients.map((recipient) => recipient.employeeId).sort()
    let id = [step.id, ...asked]
      .join('_')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120)
    for (let n = 2; taken.has(id); n += 1) {
      id = `${id.slice(0, 116)}_${n}`
    }
    taken.add(id)
    return { ...step, id }
  })
}

/**
 * The plan version a RE-MINTED seat may be named after.
 *
 * `newWorkPlanSteps` names a seat whose configuration changed `<id>_v<version>`, which is what
 * keeps a superseding version from reusing an identity. An APPEND does not advance the version,
 * so a later commit that re-mints one of the appended seats — a reorder, or a removal that
 * re-wires what a stage reads — would land on the id that seat already has, and the compile
 * refuses the collision. The compiler is told the highest version any id in this chain already
 * carries, so the next one is always free. For a chain that only ever superseded this IS its
 * plan version, and nothing changes.
 */
function stepIdVersion(existing: SessionChain): number {
  const minted = existing.steps.map((step) => Number(/_v(\d+)$/.exec(step.id)?.[1] ?? 0))
  return Math.max(existing.planVersion ?? 1, ...minted)
}

export async function commitWorkPlan(
  plan: WorkPlan,
  ctx: WorkPlanCommitContext
): Promise<{ chainId: string } | { problems: WorkPlanProblem[] }> {
  const existing = ctx.existingChain
  const outcome = workPlanOutcomeOf(plan)
  const compiled = compileWorkPlanExecution(plan, {
    ...ctx,
    ...(existing ? { existingChain: { ...existing, planVersion: stepIdVersion(existing) } } : {}),
    chainId: ctx.chain.id,
    workspacePath: ctx.chain.workspacePath
  })
  if (compiled.problems.some((p) => p.severity === 'block')) {
    return { problems: compiled.problems }
  }
  if (outcome.taskRef && ctx.commitSource !== 'user') {
    return {
      problems: [
        {
          code: 'task-ref-not-user',
          severity: 'block',
          message: 'Only you can attach this outcome to a task.'
        }
      ]
    }
  }
  const appends = ctx.mode === 'append'
  // Only a plan that REPLACES the old one supersedes it; an append leaves it running.
  const changed = Boolean(existing) && !appends
  if (
    changed &&
    existing?.outcomeSet?.attempts.some((a) =>
      ['launching', 'running', 'unverifiable'].includes(a.state)
    )
  ) {
    return {
      problems: [
        {
          code: 'supersede-active-attempt',
          severity: 'block',
          message: 'Resolve active or unverifiable attempts before changing strategy.'
        }
      ]
    }
  }
  const asks = freshHandoffIds(compiled.handoffs, existing)
  if (ctx.transcriptSource && compiled.draft.handoff.includeTranscript) {
    // The transcript is a fact about THIS conversation, which shared code cannot read. It
    // rides on the rule only when the person asked for it, so a handoff that did not is
    // never given the conversation to read.
    for (const step of asks) {
      step.handoff.transcriptSource = ctx.transcriptSource
    }
  }
  // An append ADDS work; it never re-mints a stage the chain already carries. Nothing is
  // retired in this mode, so a re-minted seat would run BESIDE the original — a stage that
  // is queued or running is followed by a new one instead (frozen model, rule 7).
  const carried = new Set(
    (existing?.steps ?? []).map((step) =>
      step.kind === 'handoff' ? step.id : (step.planNodeId ?? step.id)
    )
  )
  const version = existing ? (existing.planVersion ?? 1) + (appends ? 0 : 1) : 1
  const keeps = new Set(
    appends ? compiled.steps.filter((step) => carried.has(step.planNodeId ?? step.id)) : []
  )
  // What the dropped copies were going to be called, read as the steps the chain KEPT.
  //
  // Every commit compiles the whole plan, so an append compiles a fresh copy of each stage it is
  // queueing behind and then drops it (above). A stage this commit really adds names those copies
  // in `readsFrom` — and when the dropped copy had been RE-MINTED (the compiler judged its
  // configuration changed, which a Review does the moment a later stage reads it) its name is one
  // no step of this chain has. The reference then resolved to nothing and the appended seat was
  // launched with NO previous-stage report at all (`session-outcome-step-brief.ts` reads a declared
  // list as final), silently dropping the input the person composed the stage for.
  const retained = new Map<string, string>()
  for (const step of keeps) {
    const twin = (existing?.steps ?? []).findLast(
      (prior): prior is WorkPlanRuntimeStep =>
        prior.kind !== 'handoff' && workPlanSameSeat(prior, step)
    )
    if (twin && twin.id !== step.id) {
      retained.set(step.id, twin.id)
    }
  }
  const resolve = <T>(step: T): T => (retained.size ? remapWorkPlanStepIds(step, retained) : step)
  const handoffs = asks.map(resolve)
  const added = (appends ? compiled.steps.filter((step) => !keeps.has(step)) : compiled.steps)
    .map(resolve)
    .map((step) =>
      // The steps this commit adds belong to the plan version this chain declares. The compiler
      // assumes every commit advances it, which an append does not.
      step.planVersion === version ? step : { ...step, planVersion: version }
    )
  const chain: SessionChain = {
    ...ctx.chain,
    ...existing,
    steps: [...(existing?.steps ?? []), ...added, ...handoffs],
    end: compiled.draft.end,
    planVersion: version
  }
  delete chain.parallelOutcomeIds
  // Every id the added work names is a step this chain really carries. An unresolvable reference
  // is not a detail: the host reads it as "this seat declared its inputs", so the seat runs with
  // none of them. Refusing here says so instead of queueing work that will read nothing.
  const dangling = workPlanDanglingReferences([...added, ...handoffs], chain.steps)
  if (dangling.length) {
    return { problems: dangling }
  }
  const reason =
    ctx.supersedeReason?.trim() ||
    existing?.outcomeSet?.outcomes[0]?.blockedReason ||
    'Change strategy toward the same Outcome.'
  const stepIds = orderedStepIds(plan, chain.steps)
  const request: WorkPlanCommitRequest = {
    chain,
    outcomes: compiled.outcomes.map((definition, index) =>
      index === 0 ? { ...definition, stepIds } : definition
    ),
    expectedRevision: existing?.outcomeSet?.revision ?? 0,
    source: ctx.commitSource === 'user' ? 'user' : 'ai',
    ...(outcome.taskRef
      ? {
          taskRef:
            existing?.outcomeSet?.outcomes[0]?.taskRef?.taskId === outcome.taskRef
              ? existing.outcomeSet.outcomes[0].taskRef
              : { taskId: outcome.taskRef, attachedAt: Date.now() }
        }
      : {}),
    // Retire what this plan DROPPED, never what it still draws. The lowering named the steps the
    // plan kept; carried only on the commit that retires anything, because an append retires
    // nothing and a first commit has nothing to keep.
    ...(changed
      ? {
          supersede: { reason },
          ...(compiled.drawsSteps.length ? { drawsSteps: compiled.drawsSteps } : {})
        }
      : {})
  }
  try {
    const committed = await ctx.commitSessionOutcomes(request)
    return { chainId: committed.id }
  } catch (error) {
    return {
      problems: [
        {
          code: 'work-plan-commit',
          severity: 'block',
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    }
  }
}
