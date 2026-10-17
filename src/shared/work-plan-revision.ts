import type { SessionChain, SessionChainStep } from './session-chain-types'
import type { SessionChainHandoffStep } from './session-follow-up-rule'
import type { WorkPlanRuntimeStep } from './work-plan-runtime-adapter'
import type { WorkPlanProblem } from './work-plan-types'

/** Compare execution configuration, excluding runtime status and revision metadata. */
function configuration(step: WorkPlanRuntimeStep): string {
  const fields = [
    'prompt',
    'agent',
    'model',
    'effort',
    'accountChoiceId',
    'openrouterCandidates',
    'presetId',
    'group',
    'review',
    'reviewRepair',
    'readsFrom',
    'readsWinnerOf',
    'enabledBy',
    'verdict',
    'route',
    'writes',
    'seat',
    'onFail'
  ] as const
  return JSON.stringify(fields.map((key) => step[key] ?? null))
}

/**
 * The same SEAT of the same plan, compiled twice.
 *
 * Every commit compiles the whole plan afresh, so the copy of a node the chain already carries has
 * a new positional id. This is how the two are recognised as one seat — by the place they stand in
 * (node, editor step, review round, seat index) rather than by the name the compiler gave them.
 */
export function workPlanSameSeat(a: WorkPlanRuntimeStep, b: WorkPlanRuntimeStep): boolean {
  return (
    a.planNodeId === b.planNodeId &&
    a.editorStepId === b.editorStepId &&
    a.review?.round === b.review?.round &&
    a.seat?.index === b.seat?.index
  )
}

export function newWorkPlanSteps(
  steps: WorkPlanRuntimeStep[],
  existing: SessionChain | undefined
): WorkPlanRuntimeStep[] {
  if (!existing) {
    return steps
  }
  const old = existing.steps.filter((s) => s.kind !== 'handoff')
  const canonicalIds = new Map(
    old.map((prior) => [
      prior.id,
      steps.find((step) => workPlanSameSeat(prior, step))?.id ?? prior.id
    ])
  )
  const changed = new Set(
    steps
      .filter((step) => {
        const prior = old.findLast((s) => workPlanSameSeat(s, step))
        return (
          !prior || configuration(remapWorkPlanStepIds(prior, canonicalIds)) !== configuration(step)
        )
      })
      .map((s) => s.planNodeId)
  )
  const selected = steps.filter((s) => changed.has(s.planNodeId))
  const version = (existing.planVersion ?? 1) + 1
  const ids = new Map(selected.map((s) => [s.id, `${s.id.slice(0, 110)}_v${version}`]))
  // A node this version does NOT re-compile keeps the steps the chain already carries, so what
  // the re-minted seats READ must name THOSE ids. Every commit compiles its own copy of the whole
  // plan, and the copies of the kept nodes are dropped — a seat pointing at one named a step that
  // does not exist, which refused the next plan read ("reads from …, which is not a step of this
  // plan") and left work queued behind a predecessor that could never complete.
  const kept = new Map(
    [...canonicalIds]
      .filter(([prior, fresh]) => prior !== fresh && !ids.has(fresh))
      .map(([prior, fresh]) => [fresh, prior] as const)
  )
  return selected.map((step) => remapWorkPlanStepIds(step, new Map([...kept, ...ids])))
}

/**
 * The same step with every id it names rewritten — its own references, and the step ids the
 * compiler wrote into its brief. Used twice: when a re-minted seat must point at the steps the
 * chain kept, and when an APPEND drops a re-mint whose seat the chain already carries, so what
 * the appended stages read is the step that really exists (`work-plan-commit.ts`).
 */
export function remapWorkPlanStepIds<T>(step: T, ids: ReadonlyMap<string, string>): T {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (ids.has(value)) {
        return ids.get(value)
      }
      // A step id inside a SENTENCE carries the punctuation after it. The compiler's output
      // instruction names the id twice — once before a full stop, once before `/manifest.md` —
      // and rewriting only the second left the two disagreeing, so the sentence could never be
      // stripped back to the person's own words again: the seat read as CHANGED on every later
      // commit and was re-minted for good, each time orphaning what read from it.
      return value.replace(/[^\s/"`]+/g, (part) => {
        const exact = ids.get(part)
        if (exact) {
          return exact
        }
        const bare = part.replace(/[.,;:!?)\]}'"]+$/, '')
        const mapped = bare === part ? undefined : ids.get(bare)
        return mapped ? `${mapped}${part.slice(bare.length)}` : part
      })
    }
    if (Array.isArray(value)) {
      return value.map(rewrite)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]))
    }
    return value
  }
  return rewrite(step) as T
}

/** Who a handoff step asks, as a value; two requests to the same people are the same ask. */
function recipients(step: SessionChainHandoffStep): string {
  return JSON.stringify([
    step.handoff.recipients.map((person) => person.employeeId).sort(),
    step.handoff.disposition ?? null,
    step.handoff.action ?? null
  ])
}

/**
 * An ask whose reviewers have all ANSWERED. Counted from their own reply receipts — a receipt
 * for a `review` condition naming that person, minted after this ask was saved (the chain keeps
 * spent receipts in `evidenceHistory`, and a later version's ask must not be credited with an
 * earlier one's reply). A handoff nobody replies to (ownership: they own it, the track ends) is
 * never "answered" by this reading, which is what keeps it from being sent twice.
 */
function answeredAsk(existing: SessionChain, step: SessionChainHandoffStep): boolean {
  const receipts = [
    ...(existing.outcomeSet?.outcomes ?? []).flatMap((outcome) => outcome.evidence),
    ...(existing.outcomeSet?.evidenceHistory ?? [])
  ].filter((receipt) => receipt.kind === 'review' && receipt.verifiedAt >= step.handoff.savedAt)
  return (
    step.handoff.recipients.length > 0 &&
    step.handoff.recipients.every((recipient) =>
      receipts.some((receipt) => receipt.target === recipient.employeeId)
    )
  )
}

/**
 * The handoff steps this plan version really adds. A person the chain is still waiting on is NOT
 * asked again: their step, their receipts and their conditions stay exactly as they are, and a
 * version that re-sent a request still out would arrive as a duplicate of the one in their inbox.
 *
 * `asksAgain` is the other half: a commit where the person composed a Person block ASKS, so a
 * review of somebody who has already answered is a deliberate second ask and gets its own step
 * (`freshHandoffIds` names it after the people it asks). Without that a second review of the same
 * reviewer compiled no step at all — nobody was asked, and the work composed behind it waited on
 * the first, already-answered request for good. A commit that merely re-reads the plan (appending
 * an unrelated stage keeps the finish it had) does not ask, so nothing is re-sent behind the
 * person's back.
 */
export function newWorkPlanHandoffs(
  handoffs: SessionChainHandoffStep[],
  existing: SessionChain | undefined,
  asksAgain = false
): SessionChainHandoffStep[] {
  if (!existing) {
    return handoffs
  }
  const asked = new Set(
    existing.steps
      .filter((step): step is SessionChainHandoffStep => step.kind === 'handoff')
      .filter((step) => !asksAgain || !answeredAsk(existing, step))
      .map(recipients)
  )
  return handoffs.filter((step) => !asked.has(recipients(step)))
}

/**
 * The steps the chain already carries that THIS plan still draws.
 *
 * A superseding version retires what the old plan left unfinished (`markSupersededPlanSteps`),
 * which is right for a change of strategy and wrong for a plan that only dropped one stage or
 * one person: the nodes beside it are unchanged, so they are not re-compiled and nothing else
 * would keep them. Said here, where both halves are known: the seats whose node the plan still
 * has and did NOT re-mint (`remint`, what `newWorkPlanSteps` returned), and the person handoff
 * whose ask it still makes. `asks` is every handoff the plan compiled, BEFORE the second-ask
 * filter — that filter is what makes the existing step the current one.
 */
export function drawnWorkPlanSteps(args: {
  nodeIds: readonly string[]
  remint: readonly WorkPlanRuntimeStep[]
  asks: readonly SessionChainHandoffStep[]
  existing: SessionChain | undefined
}): string[] {
  const { existing } = args
  if (!existing) {
    return []
  }
  const reminted = new Set(args.remint.map((step) => step.planNodeId ?? step.id))
  const drawn = new Set(args.nodeIds)
  return [
    ...existing.steps
      .filter((step): step is WorkPlanRuntimeStep => step.kind !== 'handoff')
      .filter((step) => {
        const node = step.planNodeId ?? step.id
        return drawn.has(node) && !reminted.has(node)
      })
      .map((step) => step.id),
    ...keptWorkPlanHandoffs(args.asks, existing).map((step) => step.id)
  ]
}

/**
 * The other half of `newWorkPlanHandoffs`: the handoff steps the chain ALREADY carries whose ask
 * this plan still makes.
 *
 * Because a second ask is suppressed, the step that made the first one is what the plan's finish
 * still draws — so a superseding version must not retire it. Without this a commit that only
 * removed a stage took the plan's own finish with it: the people were left in the Outcome's
 * conditions with the step that reaches them marked skipped.
 */
export function keptWorkPlanHandoffs(
  handoffs: readonly SessionChainHandoffStep[],
  existing: SessionChain | undefined
): SessionChainHandoffStep[] {
  if (!existing) {
    return []
  }
  const asks = new Set(handoffs.map(recipients))
  return existing.steps
    .filter((step): step is SessionChainHandoffStep => step.kind === 'handoff')
    .filter((step) => asks.has(recipients(step)))
}

/** Every step id one step names: what it reads, what enables it, and what its verdict judges. */
function references(step: SessionChainStep): string[] {
  if (step.kind === 'handoff') {
    return []
  }
  return [
    ...(step.readsFrom ?? []),
    ...(step.readsWinnerOf ? [step.readsWinnerOf] : []),
    ...(step.enabledBy ? [step.enabledBy.verdict, step.enabledBy.seatsOf] : []),
    ...((step as WorkPlanRuntimeStep).onFail ? [(step as WorkPlanRuntimeStep).onFail!] : []),
    // A `verify` verdict is over the Outcome's CONDITION ids; every other kind judges steps.
    ...(step.verdict && step.verdict.kind !== 'verify' ? step.verdict.over : [])
  ]
}

/**
 * The references the work this commit ADDS cannot resolve against the chain it is joining.
 *
 * A step id is a promise: the host hands a seat the reports of the steps it declared and holds it
 * until the verdict that enables it lands. A name no step answers to is not a smaller version of
 * that promise — it is silence (the brief resolves the declared list to nothing and sends none of
 * it), so it is refused at the boundary rather than committed.
 */
export function workPlanDanglingReferences(
  added: readonly SessionChainStep[],
  steps: readonly SessionChainStep[]
): WorkPlanProblem[] {
  const known = new Set(steps.map((step) => step.id))
  return added.flatMap((step) =>
    references(step)
      .filter((id) => !known.has(id))
      .map((id) => ({
        code: 'step-reference-missing',
        severity: 'block' as const,
        message: `${step.id} reads from ${id}, which is not a step of this plan.`
      }))
  )
}
