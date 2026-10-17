// A decision contract is the written, versioned description of one kind of judgement JEV makes.

/** Every place a workflow asks JEV to decide something. */
export const DECISION_KINDS = [
  'rank-ballot',
  'screen-order',
  'set-aside-gate',
  'hard-limit-gate',
  'criterion-line',
  'final-check',
  'one-answer-route',
  'finding-verify'
] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** `id@version`: a published version never changes, so a new rule is always a new version. */
export type ContractRef = `${string}@${number}`

/** How JEV's answer becomes sure or unsure; `scores` orders only and has no unsure rule. */
export type ConfidencePolicy =
  | {
      method: 'auto'
      pairwiseUpTo: number
      scoreMargin: number
      pairBand: readonly [number, number]
    }
  | { method: 'pairwise'; pairBand: readonly [number, number] }
  | { method: 'score-line'; below: number }
  | { method: 'noul'; question: string; band: readonly [number, number]; bothOrders?: true }
  | { method: 'scores' }

export type UnknownReason = 'jev-failed' | 'unscored' | 'unsure' | 'no-counted-vote' | 'too-long'

/** What a run does once JEV's judgement stays unknown; none of these reads unknown as a low score. */
export const UNKNOWN_OUTCOMES = [
  'models-decide',
  'keep-and-verify',
  'keep-incumbent',
  'keep-chair',
  'full-workflow',
  'gap'
] as const
export type UnknownOutcome = (typeof UNKNOWN_OUTCOMES)[number]

export type DecisionGate = { id: string; by: 'rule' | 'jev'; means: string }

export type DecisionCriteria = {
  from: 'step-instruction' | 'rubric-from-step' | 'fixed' | 'generic'
  lines?: readonly string[]
}

export type DecisionContract = {
  id: string
  version: number
  kind: DecisionKind
  serves: string
  evidence: readonly string[]
  gates: readonly DecisionGate[]
  criteria: DecisionCriteria
  // `fallback`, not `then`: an object with `then` is thenable and would be awaited by mistake.
  unknown: { when: readonly UnknownReason[]; fallback: UnknownOutcome }
  confidence: ConfidencePolicy
  harm: 'false-yes' | 'false-no' | 'symmetric'
  target: { minItems: number; maxConfidentDisagreement: number }
  goldenSet?: string
  replaces?: ContractRef
}

/** A judge's order of answers needs fewer labelled pairs than a yes/no gate to measure. */
export const RANKING_TARGET = { minItems: 40, maxConfidentDisagreement: 0.05 } as const

/** A yes/no gate or route needs more labelled cases than an order does. */
export const GATE_TARGET = { minItems: 80, maxConfidentDisagreement: 0.05 } as const

export function contractRefOf(contract: Pick<DecisionContract, 'id' | 'version'>): ContractRef {
  return `${contract.id}@${contract.version}`
}
