import {
  DECISION_EXPERIMENT_TARIFF,
  decisionNoulBrier
} from '../../../../src/main/structured-decisions/decision-experiment-metrics'
import { jevDecide, jevRank } from '../../../../src/main/structured-decisions/jev-rank'
import type { DecisionResult } from '../../../../src/shared/structured-decisions'
import { ONE_ANSWER_QUESTION } from '../../../../src/shared/jev-confidence'
import { WORKFLOW_SCREEN_SET_ASIDE } from '../../../../src/shared/workflow-graph'

/**
 * Benchmark only: measures JEV NOUL yes/no gates against the rule each workflow uses today, on
 * known answers. Nothing here changes a live workflow's decision; switching comes after the numbers.
 */

export const NOUL_THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7] as const
/** A NOUL answer inside this band would go to a frontier model instead (NOUL only). */
export const NOUL_UNSURE_BAND = [0.35, 0.65] as const

type Tokens = { input: number; output: number }

export type GateSample = {
  id: string
  /** The truth: a real in-scope defect, a question with one right answer, B is the better answer. */
  truth: boolean
  noul: { probability: number; tokens?: Tokens } | { failed: string }
  /** Today's rule: its decision, its probability when it has one, and its cost when known. */
  current:
    | {
        decision: boolean
        probability?: number
        /** The rule's own unsure call, when it makes one (jevRank's band and order check). */
        unsure?: boolean
        tokens?: Tokens
      }
    | { failed: string }
}

export type GateReport = {
  gate: string
  rule: string
  n: number
  noul: {
    answered: number
    failed: number
    brier: number | null
    byThreshold: { threshold: number; accuracy: number | null }[]
    unsureRate: number | null
    costUsdPerDecision: number | 'unknown'
  }
  current: {
    failed: number
    accuracy: number | null
    brier: number | null
    /** The rule's own unsure calls; null when the rule makes none (it never defers). */
    unsureRate: number | null
    costUsdPerDecision: number | 'unknown'
  }
}

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

const unsure = (probability: number) =>
  probability > NOUL_UNSURE_BAND[0] && probability < NOUL_UNSURE_BAND[1]

/** JEV's price per decision from reported tokens; unknown unless every decision reported them. */
function costPerDecision(tokens: readonly (Tokens | undefined)[]): number | 'unknown' {
  if (!tokens.length || tokens.some((entry) => !entry)) {
    return 'unknown'
  }
  const usd = (tokens as Tokens[]).map(
    (entry) =>
      (entry.input * DECISION_EXPERIMENT_TARIFF.inputUsdPerMillion +
        entry.output * DECISION_EXPERIMENT_TARIFF.outputUsdPerMillion) /
      1_000_000
  )
  return mean(usd)!
}

export function gateReport(gate: string, rule: string, samples: readonly GateSample[]): GateReport {
  const answered = samples.flatMap((sample) =>
    'probability' in sample.noul
      ? [{ ...sample, p: sample.noul.probability, tokens: sample.noul.tokens }]
      : []
  )
  const decided = samples.flatMap((sample) =>
    'decision' in sample.current ? [{ truth: sample.truth, ...sample.current }] : []
  )
  const withProbability = decided.filter((sample) => sample.probability !== undefined)
  return {
    gate,
    rule,
    n: samples.length,
    noul: {
      answered: answered.length,
      failed: samples.length - answered.length,
      brier: mean(answered.map((sample) => decisionNoulBrier(sample.p, sample.truth))),
      byThreshold: NOUL_THRESHOLDS.map((threshold) => ({
        threshold,
        accuracy: mean(answered.map((sample) => Number(sample.p >= threshold === sample.truth)))
      })),
      unsureRate: mean(answered.map((sample) => Number(unsure(sample.p)))),
      costUsdPerDecision: costPerDecision(answered.map((sample) => sample.tokens))
    },
    current: {
      failed: samples.length - decided.length,
      accuracy: mean(decided.map((sample) => Number(sample.decision === sample.truth))),
      brier: mean(
        withProbability.map((sample) => decisionNoulBrier(sample.probability!, sample.truth))
      ),
      unsureRate: mean(
        decided.flatMap((sample) => (sample.unsure === undefined ? [] : [Number(sample.unsure)]))
      ),
      costUsdPerDecision: costPerDecision(decided.map((sample) => sample.tokens))
    }
  }
}

export type NoulAsk = typeof jevDecide
export type PairRank = typeof jevRank

async function noul(
  ask: NoulAsk,
  capability: string,
  state: Record<string, string>,
  instructions: string
): Promise<{ probability: number; tokens: Tokens } | { failed: string }> {
  const result = await ask({
    capability,
    state,
    questions: { yes: { type: 'noul', instructions } }
  })
  if ('failed' in result) {
    return result
  }
  const answer = (result as DecisionResult).answers.yes
  return answer?.type === 'noul'
    ? {
        probability: answer.noul,
        tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens }
      }
    : { failed: 'JEV answered without a yes-probability' }
}

export const SET_ASIDE_QUESTION =
  'Is state.finding a real, in-scope defect for state.goal: a concrete trigger that leads to a wrong result in this code, not a style point, a guess or a restatement of correct behaviour?'
export { ONE_ANSWER_QUESTION }
export const BETTER_QUESTION =
  'For state.task, is state.response_b a better answer than state.response_a? Judge accuracy, completeness and usefulness; ignore which is shown first and which is longer.'

/** Set-aside: a finding the screen scored below the line (and reported once) is set aside today. */
export async function probeSetAside(
  goal: string,
  findings: readonly {
    id: string
    truth: boolean
    text: string
    jevScore?: number
    repeats: number
    /** P(score at or above the line) from JEV's level probabilities, when the run kept them. */
    keepProbability?: number
  }[],
  ask: NoulAsk = jevDecide
): Promise<GateSample[]> {
  const samples: GateSample[] = []
  for (const finding of findings) {
    const score = finding.jevScore ?? 2
    samples.push({
      id: finding.id,
      truth: finding.truth,
      noul: await noul(
        ask,
        'benchmark.set_aside',
        { goal, finding: finding.text },
        SET_ASIDE_QUESTION
      ),
      current: {
        decision: score >= WORKFLOW_SCREEN_SET_ASIDE || finding.repeats > 1,
        probability: finding.keepProbability ?? score / 4
      }
    })
  }
  return samples
}

/** One-answer routing: no rule decides it today, so every question is handled as judgment. */
export async function probeOneAnswer(
  questions: readonly { id: string; question: string; kind: 'one-answer' | 'judgment' }[],
  ask: NoulAsk = jevDecide
): Promise<GateSample[]> {
  const samples: GateSample[] = []
  for (const entry of questions) {
    samples.push({
      id: entry.id,
      truth: entry.kind === 'one-answer',
      noul: await noul(
        ask,
        'benchmark.one_answer',
        { question: entry.question },
        ONE_ANSWER_QUESTION
      ),
      current: { decision: false }
    })
  }
  return samples
}

/** Final check: NOUL asked in both orders against today's both-orders pairwise ranking. */
export async function probeFinalCheck(
  pairs: readonly { id: string; task: string; a: string; b: string; better: 'a' | 'b' }[],
  ask: NoulAsk = jevDecide,
  rank: PairRank = jevRank
): Promise<GateSample[]> {
  const samples: GateSample[] = []
  for (const pair of pairs) {
    const [forward, backward] = [
      await noul(
        ask,
        'benchmark.final_check',
        { task: pair.task, response_a: pair.a, response_b: pair.b },
        BETTER_QUESTION
      ),
      await noul(
        ask,
        'benchmark.final_check',
        { task: pair.task, response_a: pair.b, response_b: pair.a },
        BETTER_QUESTION
      )
    ]
    const ranking = await rank({
      method: 'pairwise',
      task: pair.task,
      rubric: '',
      candidates: [
        { id: 'a', text: pair.a },
        { id: 'b', text: pair.b }
      ]
    })
    const usage =
      'failed' in ranking
        ? undefined
        : (ranking as { usage?: { inputTokens: number; outputTokens: number } }).usage
    samples.push({
      id: pair.id,
      truth: pair.better === 'b',
      noul:
        'failed' in forward
          ? forward
          : 'failed' in backward
            ? backward
            : {
                probability: (forward.probability + 1 - backward.probability) / 2,
                tokens: {
                  input: forward.tokens.input + backward.tokens.input,
                  output: forward.tokens.output + backward.tokens.output
                }
              },
      current:
        'failed' in ranking
          ? ranking
          : {
              decision: ranking.order[0] === 'b',
              probability: ranking.scores.b ?? 0.5,
              unsure: ranking.unsure,
              ...(usage ? { tokens: { input: usage.inputTokens, output: usage.outputTokens } } : {})
            }
    })
  }
  return samples
}
