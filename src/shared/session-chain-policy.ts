import { isIndependentLineage, mayIssueVerdict, modelLineage } from './model-lineage'
import { isSessionVerdictPresetId } from './session-action-presets'
import {
  isSessionChainAgentStep,
  sessionChainPredecessors,
  type SessionChain,
  type SessionChainAgentStep
} from './session-chain-types'

/**
 * The estate's review rules, checked on a compiled plan before it runs:
 * a reviewer or judge never carries a Gemini verdict; the seat that reviews work is never
 * the exact model that produced it; and a judge over several candidates comes from a
 * family none of the candidates belong to. A warning names a weaker seat the plan may
 * still run with; a block names one it may not.
 */
export type SessionChainPolicyProblem = {
  level: 'block' | 'warn'
  code:
    | 'gemini-verdict'
    | 'unknown-lineage'
    | 'reviewer-is-producer'
    | 'judge-in-candidates'
    | 'same-lineage'
  stepId: string
  message: string
}

/** The seat whose work a plan's first steps read: the session the plan runs after. */
export type SessionChainSource = { agent: string; model?: string | null }

type Seat = Pick<SessionChainAgentStep, 'agent' | 'model'>

function exact(seat: Seat): string {
  return `${seat.agent}:${seat.model ?? ''}`
}

function seatName(seat: Seat): string {
  return seat.model ? `${seat.agent} ${seat.model}` : seat.agent
}

/** WP-0.5 adds these fields to the step type; read them defensively until that lands. */
function stepVerdict(step: SessionChainAgentStep): { kind?: unknown; over?: unknown } | null {
  const raw = (step as { verdict?: unknown }).verdict
  return raw && typeof raw === 'object' ? (raw as { kind?: unknown; over?: unknown }) : null
}

function stepReads(step: SessionChainAgentStep): string[] {
  const verdict = stepVerdict(step)
  const declared = [(step as { readsFrom?: unknown }).readsFrom, verdict?.over].flatMap((value) =>
    Array.isArray(value) ? value : []
  )
  return [...new Set(declared.filter((id): id is string => typeof id === 'string'))]
}

function isVerdictStep(step: SessionChainAgentStep): boolean {
  return (
    Boolean(step.review) || Boolean(stepVerdict(step)) || isSessionVerdictPresetId(step.presetId)
  )
}

function isJudgeStep(step: SessionChainAgentStep): boolean {
  return stepVerdict(step)?.kind === 'judge' || step.presetId === 'judge'
}

/**
 * What a verdict step judges: the steps it says it reads (its `readsFrom` and whatever its
 * verdict ranges over), else the steps before it, else the plan's source session. Verdict steps
 * are never candidates, so naming a critique instead of the work cannot hide a family collision.
 */
function producersOf(
  chain: Pick<SessionChain, 'steps'>,
  index: number,
  source: SessionChainSource | null
): Seat[] {
  const step = chain.steps[index]
  const declared = step && isSessionChainAgentStep(step) ? stepReads(step) : []
  const named =
    declared.length > 0
      ? declared.flatMap((id) => {
          const found = chain.steps.find((candidate) => candidate.id === id)
          return found && isSessionChainAgentStep(found) ? [found] : []
        })
      : sessionChainPredecessors(chain, index)
  const predecessors = named.filter((candidate) => !isVerdictStep(candidate))
  if (predecessors.length > 0) {
    return predecessors
  }
  return source ? [{ agent: source.agent as Seat['agent'], model: source.model ?? undefined }] : []
}

export function sessionChainPolicyProblems(
  chain: Pick<SessionChain, 'steps'>,
  source: SessionChainSource | null = null
): SessionChainPolicyProblem[] {
  const problems: SessionChainPolicyProblem[] = []
  chain.steps.forEach((step, index) => {
    if (!isSessionChainAgentStep(step) || !isVerdictStep(step)) {
      return
    }
    if (!mayIssueVerdict(step.agent, step.model)) {
      const google = modelLineage(step.agent, step.model) === 'google'
      problems.push({
        level: 'block',
        code: google ? 'gemini-verdict' : 'unknown-lineage',
        stepId: step.id,
        message: google
          ? 'Gemini never issues a review verdict. Choose Claude, Codex or Grok to review.'
          : `This build cannot tell which model family ${seatName(step)} draws on, so it cannot be shown to be independent of the work it reviews. Choose Claude, Codex or Grok to review.`
      })
      return
    }
    const producers = producersOf(chain, index, source)
    if (producers.length === 0) {
      return
    }
    const lineage = modelLineage(step.agent, step.model)
    const candidates = producers.filter((seat) => exact(seat) !== exact(step))
    if (producers.length === 1 && candidates.length === 0 && step.model && producers[0]!.model) {
      problems.push({
        level: 'block',
        code: 'reviewer-is-producer',
        stepId: step.id,
        message: `${seatName(step)} would review its own work. A reviewer is never the model that produced the result; choose another model.`
      })
      return
    }
    // Why a judge with ONE candidate also blocks: a judge is asked to decide, not to advise, so
    // sharing a family with the only candidate is the same defect as sharing it with one of three.
    if (producers.length > 1 || isJudgeStep(step)) {
      // Why: a judge from one candidate's family is not a neutral judge of the others.
      const shared = producers.find(
        (seat) => !isIndependentLineage(modelLineage(seat.agent, seat.model), lineage)
      )
      if (shared) {
        problems.push({
          level: 'block',
          code: 'judge-in-candidates',
          stepId: step.id,
          message: `${seatName(step)} judges candidates that include its own family (${seatName(shared)}). A judge comes from a family none of the candidates belong to.`
        })
      }
      return
    }
    if (!isIndependentLineage(modelLineage(producers[0]!.agent, producers[0]!.model), lineage)) {
      problems.push({
        level: 'warn',
        code: 'same-lineage',
        stepId: step.id,
        message: `${seatName(step)} reviews work from its own family (${seatName(producers[0]!)}). A second family catches what the first cannot see.`
      })
    }
  })
  return problems
}

export function sessionChainPolicyBlocks(
  problems: readonly SessionChainPolicyProblem[]
): SessionChainPolicyProblem[] {
  return problems.filter((problem) => problem.level === 'block')
}
