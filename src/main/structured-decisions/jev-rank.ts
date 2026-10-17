import {
  DecisionProviderError,
  type DecisionCallTag,
  type DecisionFailureCode,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'
import type { ConfidencePolicy } from '../../shared/decision-contracts/decision-contract-types'
import {
  JEV_AUTO_PAIRWISE_MAX,
  JEV_SCORE_MARGIN,
  JEV_UNSURE_BAND
} from '../../shared/jev-confidence'
import { resolveTypesafeCredential } from './decision-credential'
import { decisionEnvironmentKilled } from './decision-configuration'
import {
  rankJevByRubric,
  screenJevByRubric,
  type JevScreen,
  type JevScreenRequest
} from './jev-rank-rubric'
import { rankHeadToHead } from './jev-rank-pairwise'
import { TypeSafeDecisionProvider } from './typesafe-provider'
import { recordJevNotCalled } from './jev-call-rows'
import type { JevCertainty, JevPairJudgment, JevUsage } from './jev-certainty'

export { JEV_SCORE_MARGIN, JEV_SCORE_LEVELS } from './jev-rank-rubric'
export type { JevScreen, JevScreenRequest } from './jev-rank-rubric'
export type { JevCertainty, JevPairJudgment, JevUsage } from './jev-certainty'

/**
 * The one way OmniConsole asks JEV which of several answers is best. Workflows (Improve, Best of
 * N, Council) use it today; anything that needs a fast, cheap, structured comparison should too,
 * so every JEV judgment in the app shares the same rubric format, both-orders pairwise and
 * uncertainty rule. JEV advises: it is never a gate by itself, and when it is unsure the caller
 * should let a stronger judge decide.
 */
export type JevRankMethod = 'auto' | 'rubric' | 'pairwise'

/** A decision contract's ranking policy: the thresholds that make JEV sure or unsure. */
export type JevRankPolicy = Extract<ConfidencePolicy, { method: 'auto' | 'pairwise' }>

export type JevRankRequest = {
  method: JevRankMethod
  task: string
  /** What good means (see shared/jev-rubric.ts); empty uses the general rubric. */
  rubric: string
  candidates: { id: string; text: string }[]
  /**
   * The answer to beat (Improve's best version so far). Head to head is not transitive, so JEV is
   * also unsure when its top answer does not clearly beat this one; by rubric scores that follows
   * from the top-two rule.
   */
  incumbent?: string
  capability?: string
  /** The frozen contract's thresholds; absent, today's constants apply. */
  policy?: JevRankPolicy
}

export type JevRanking = {
  method: 'rubric' | 'pairwise'
  model: string
  /** Candidate ids, best first; ties keep the given order. */
  order: string[]
  /** Rubric: overall score 0–4. Pairwise: share of comparisons won, 0–1. */
  scores: Record<string, number>
  /** Rubric only: JEV's confidence and level probabilities per candidate, when it gave them. */
  certainty?: Record<string, JevCertainty>
  /** Rubric only: each criterion's scores for candidates evaluated on that criterion. */
  criteria: {
    id: string
    label: string
    scores: Record<string, number>
    certainty?: Record<string, JevCertainty>
  }[]
  /** Pairwise only: every judged pair in the order shown, for calibration. */
  pairs?: JevPairJudgment[]
  usage?: JevUsage
  /** Pairwise only: rubric criteria that most often explained the preferences. */
  drivers?: { id: string; label: string; comparisons: number }[]
  /** JEV could not clearly separate the top two: a stronger judge should decide. */
  unsure: boolean
  unsureReason?: string
  calls: number
}

type Evaluate = (
  request: DecisionRequest,
  options: { signal: AbortSignal; call?: DecisionCallTag }
) => Promise<DecisionResult>

export type JevRankOptions = {
  evaluate?: Evaluate
  credential?: () => Promise<string | undefined>
  environment?: NodeJS.ProcessEnv
  /** The feature id on this call's ledger rows; defaults to the request capability. */
  caller?: string
}

export { JEV_UNSURE_BAND }
const REQUEST_TIMEOUT_MS = 8_000
type Ask = (request: DecisionRequest) => Promise<DecisionResult>
type Pending = Pick<DecisionRequest, 'capability'> & Partial<DecisionRequest>
const directCall = (options: JevRankOptions, capability: string): DecisionCallTag => ({
  caller: options.caller ?? capability,
  transport: 'direct',
  deadlineMs: REQUEST_TIMEOUT_MS
})

/** Why JEV cannot judge on this computer right now, or undefined when it can. */
export function jevUnavailableReason(environment: NodeJS.ProcessEnv): string | undefined {
  const disabled = environment.JEV_DECISIONS_DISABLED
  return decisionEnvironmentKilled(environment) ||
    (disabled && !['0', 'false'].includes(disabled.toLowerCase()))
    ? 'JEV is turned off on this computer'
    : undefined
}

/**
 * One JEV request with a time limit, or why JEV cannot be asked on this computer. A refusal
 * before any request still leaves one `not_called` ledger row for `pending`.
 */
async function jevAsk(
  options: JevRankOptions,
  pending: Pending
): Promise<Ask | { failed: string }> {
  const refuse = (reason: DecisionFailureCode, failed: string) => {
    recordJevNotCalled(pending, directCall(options, pending.capability), reason)
    return { failed }
  }
  const environment = options.environment ?? process.env
  const off = jevUnavailableReason(environment)
  if (off) {
    return refuse('disabled', off)
  }
  let key: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Error('timed out')
  try {
    // Bounded like the request: a lookup that never settles must not hold the caller forever.
    key = await Promise.race([
      (options.credential ?? resolveTypesafeCredential)(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timedOut), REQUEST_TIMEOUT_MS)
      })
    ])
  } catch (error) {
    // The reason stays generic: a credential error must never carry the key into a log.
    const reason = error === timedOut ? 'timeout' : 'no_api_key'
    return refuse(reason, 'the TypeSafe API key could not be read')
  } finally {
    clearTimeout(timer)
  }
  if (!key) {
    return refuse('no_api_key', 'no TypeSafe API key (TYPESAFE_API_KEY)')
  }
  const provider = new TypeSafeDecisionProvider({ resolveApiKey: async () => key })
  const evaluate = options.evaluate ?? provider.evaluate.bind(provider)
  return async (decision: DecisionRequest) => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DecisionProviderError('timeout')),
      REQUEST_TIMEOUT_MS
    )
    try {
      const call = directCall(options, decision.capability)
      return await evaluate(decision, { signal: controller.signal, call })
    } finally {
      clearTimeout(timer)
    }
  }
}

const reasonOf = (error: unknown) =>
  error instanceof DecisionProviderError
    ? `JEV answered ${error.code}`
    : error instanceof Error
      ? error.message
      : String(error)

/**
 * JEV's scores for a whole pool of options against a rubric, or why it could not give any. The
 * screen tolerates a single non-transient miss (see `screenJevByRubric`), naming it a gap: it
 * fails only when nothing scored, or when any candidate failed for a transient reason (rate
 * limit, overload, network, timeout) — a partial page is never cached half-scored; the whole page
 * fails, retryable, so Retry re-asks it, at a cost of a fraction of a cent.
 */
export async function jevScreen(
  request: JevScreenRequest,
  options: JevRankOptions = {}
): Promise<JevScreen | { failed: string; retryable?: boolean }> {
  const ask = await jevAsk(options, { capability: request.capability ?? 'workflow.judge' })
  if (typeof ask !== 'function') {
    return ask
  }
  try {
    const screen = await screenJevByRubric(request, ask)
    if (screen.retryableUnscored.length) {
      return {
        failed: `JEV could not score ${screen.retryableUnscored.length} of ${request.candidates.length} options${screen.lastError ? ` (${screen.lastError})` : ''}`,
        retryable: true
      }
    }
    return Object.keys(screen.scores).length
      ? screen
      : {
          failed: `JEV could not score any of the ${request.candidates.length} options${screen.lastError ? ` (${screen.lastError})` : ''}`
        }
  } catch (error) {
    return {
      failed: reasonOf(error),
      ...(error instanceof DecisionProviderError && error.retryable ? { retryable: true } : {})
    }
  }
}

/**
 * One JEV request with the shared credential, kill switch and time limit, for a caller that asks
 * its own questions (next steps ask many yes/no questions in one call), or why it could not.
 */
export async function jevDecide(
  request: DecisionRequest,
  options: JevRankOptions = {}
): Promise<DecisionResult | { failed: string }> {
  try {
    const ask = await jevAsk(options, request)
    return typeof ask === 'function' ? await ask(request) : ask
  } catch (error) {
    return { failed: reasonOf(error) }
  }
}

/** JEV's ranking of the answers, or why it could not give one. One failed call voids it. */
export async function jevRank(
  request: JevRankRequest,
  options: JevRankOptions = {}
): Promise<JevRanking | { failed: string }> {
  const ask = await jevAsk(options, { capability: request.capability ?? 'workflow.judge' })
  if (typeof ask !== 'function') {
    return ask
  }
  const { policy } = request
  const pairwiseUpTo = policy?.method === 'auto' ? policy.pairwiseUpTo : JEV_AUTO_PAIRWISE_MAX
  const method =
    request.method === 'auto'
      ? request.candidates.length <= pairwiseUpTo
        ? 'pairwise'
        : 'rubric'
      : request.method
  try {
    return method === 'pairwise'
      ? await rankHeadToHead(request, ask, policy?.pairBand ?? JEV_UNSURE_BAND)
      : await rankJevByRubric(
          request,
          ask,
          policy?.method === 'auto' ? policy.scoreMargin : JEV_SCORE_MARGIN
        )
  } catch (error) {
    return { failed: reasonOf(error) }
  }
}
