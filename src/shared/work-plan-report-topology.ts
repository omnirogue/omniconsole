import type { SessionChain, SessionChainAgentStep, SessionChainStep } from './session-chain-types'

/** What a seat is doing, as the host last observed it. */
export type WorkPlanReportSeatState =
  | 'done'
  | 'running'
  | 'queued'
  | 'waiting'
  | 'failed'
  | 'skipped'

export type WorkPlanReportSeat = {
  stepId: string
  actor: string
  model?: string
  effort?: string
  instruction: string
  state: WorkPlanReportSeatState
  /** "round 2 of 3" for a review seat; absent otherwise. */
  rounds?: string
  /** The verdict this seat emits and how the host spends it. */
  verdict?: string
  /** The receipt the host actually holds for this seat's verdict, if any. */
  verdictReceipt?: string
  launchedAt?: number
}

export type WorkPlanReportStage = {
  id: string
  title: string
  /** ◇ synthesize · ⚖ judge · ✨ improve · ✓ verify · 📝 plan · 👤 human. WP-2 owns the notation STRING. */
  glyph: string
  seats: WorkPlanReportSeat[]
  parallel: boolean
  /** The stage the chain is on now: it holds the first seat that is not finished. */
  current: boolean
}

export type WorkPlanReportRuntime = {
  /** A fixed clock: the same chain must always render the same bytes. */
  now: number
  /** What the host observed this tick, per step id; absent falls back to the chain's own record. */
  seats?: Record<string, WorkPlanReportSeatState>
  /** Which plan version produced this report (WP-0.5 (b) types it on the chain). */
  planVersion?: number
}

const GLYPHS: Record<string, string> = {
  synthesize: '◇',
  summarize: '◇',
  judge: '⚖',
  compare: '⚖',
  improve: '✨',
  repair: '✨',
  verify: '✓',
  review: '✓',
  critique: '✓',
  test: '✓',
  plan: '📝'
}

function isAgentStep(step: SessionChainStep): step is SessionChainAgentStep {
  return step.kind !== 'handoff'
}

function seatState(chain: SessionChain, step: SessionChainAgentStep): WorkPlanReportSeatState {
  if (step.status === 'failed') {
    return 'failed'
  }
  if (step.status === 'skipped') {
    return 'skipped'
  }
  const set = chain.outcomeSet
  if (set?.completedSteps?.includes(step.id)) {
    return 'done'
  }
  const attempt = set?.attempts.find((entry) => entry.actionId === `step_${step.id}`)
  if (attempt?.state === 'completed') {
    return 'done'
  }
  if (attempt?.state === 'running' || attempt?.state === 'launching') {
    return 'running'
  }
  if (attempt && attempt.state !== 'prepared') {
    return 'failed'
  }
  return step.wait ? 'waiting' : 'queued'
}

/**
 * The chain as stages of seats: consecutive steps of one `group` are one PARALLEL stage, everything
 * else is its own sequential stage. This is the same folding the stage cap counts, so the diagram
 * and the cap can never disagree about what "a stage" is.
 */
export function workPlanReportStages(
  chain: SessionChain,
  runtime: WorkPlanReportRuntime,
  finish?: { finish: string; status: string }
): WorkPlanReportStage[] {
  const stages: WorkPlanReportStage[] = []
  for (const step of chain.steps) {
    if (!isAgentStep(step)) {
      stages.push({
        id: step.id,
        title: 'A person',
        glyph: '👤',
        parallel: false,
        current: false,
        seats: [
          {
            stepId: step.id,
            actor: 'person',
            instruction: step.handoff.taskTitle,
            state: step.status === 'delivered' ? 'done' : 'queued'
          }
        ]
      })
      continue
    }
    const seat: WorkPlanReportSeat = {
      stepId: step.id,
      actor: step.agent,
      ...(step.model ? { model: step.model } : {}),
      ...(step.effort ? { effort: step.effort } : {}),
      instruction: step.prompt,
      state: runtime.seats?.[step.id] ?? seatState(chain, step),
      ...(step.review ? { rounds: `round ${step.review.round} of ${step.review.maxRounds}` } : {}),
      ...(step.verdict
        ? {
            verdict: `${step.verdict.kind} over ${step.verdict.over.join(', ')} · ${step.verdict.consumed}`
          }
        : {}),
      ...(chain.verdicts?.some((receipt) => receipt.stepId === step.id)
        ? {
            verdictReceipt: chain.verdicts.find((receipt) => receipt.stepId === step.id)!
              .consumptionKey
          }
        : {}),
      ...(step.launchedAt ? { launchedAt: step.launchedAt } : {})
    }
    const key = step.group ?? step.id
    const open = stages.at(-1)
    if (step.group && open?.id === key) {
      open.seats.push(seat)
      open.parallel = true
      continue
    }
    stages.push({
      id: key,
      title: step.presetId ?? step.role ?? 'step',
      glyph: (step.presetId && GLYPHS[step.presetId]) ?? '',
      parallel: false,
      current: false,
      seats: [seat]
    })
  }
  // The finish is a stage of the plan, not a step of the chain: a person is where it ends, and a
  // diagram that stops at the last agent seat hides who the work is actually for.
  const human = finish?.finish === 'my-review' || finish?.finish === 'human-handoff'
  if (finish && finish.finish !== 'complete') {
    stages.push({
      id: `finish-${finish.finish}`,
      title: human ? (finish.finish === 'my-review' ? 'your review' : 'a person') : finish.finish,
      glyph: human ? '👤' : '',
      parallel: false,
      current: false,
      seats: [
        {
          stepId: `finish-${finish.finish}`,
          actor: human ? 'you' : finish.finish,
          instruction: `Finish: ${finish.finish}`,
          state: finish.status === 'satisfied' ? 'done' : 'queued'
        }
      ]
    })
  }
  const live = stages.find((stage) =>
    stage.seats.some((seat) => seat.state !== 'done' && seat.state !== 'skipped')
  )
  if (live) {
    live.current = true
  }
  return stages
}

/** k/n over the Outcome's own Done When entries: only a receipt at the current revision counts. */
export function workPlanReportDoneWhen(outcome: {
  revision: number
  id: string
  conditions: { id: string; label?: string; kind: string; target: string }[]
  evidence: { conditionId: string; outcomeRevision: number; receipt: string; verifiedAt: number }[]
}): { id: string; label: string; satisfied: boolean; receipt?: string; verifiedAt?: number }[] {
  return outcome.conditions.map((condition) => {
    const proof = outcome.evidence.find(
      (entry) => entry.conditionId === condition.id && entry.outcomeRevision === outcome.revision
    )
    return {
      id: condition.id,
      label: condition.label ?? `${condition.kind}: ${condition.target}`,
      satisfied: Boolean(proof),
      ...(proof ? { receipt: proof.receipt, verifiedAt: proof.verifiedAt } : {})
    }
  })
}
