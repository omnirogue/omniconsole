import { createHash, randomUUID } from 'node:crypto'
import type { JevCallAnswer, JevProviderStatus } from '../../shared/jev-ledger'
import type { JevTrialAnswer, JevTrialResult } from '../../shared/jev-trial-workflow'
import { SAVED_RUBRIC_PREFIX, type RubricLibraryEntry } from '../../shared/rubric-library'
import {
  DECISION_MAX_TIMEOUT_MS,
  DecisionProviderError,
  type DecisionAnswer,
  type DecisionCallTag,
  type DecisionFailureCode,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'
import { jevCallLedger, type JevCallFields } from './jev-ledger'
import type { JevRubricEvaluationRecord } from './jev-rubric-evaluation'

export const hashOf = (value: unknown): string | null => {
  try {
    return value === undefined
      ? null
      : createHash('sha256').update(JSON.stringify(value)).digest('hex')
  } catch {
    return null
  }
}
const rounded = (ms: number): number => Math.round(ms * 10) / 10

/**
 * Built-in rubric ids are fixed names. A saved rubric's name is free text that can carry a
 * customer's name or number, so its row keeps only `saved:<sha256 of the name>`.
 */
export function rubricRef(rubric: Pick<RubricLibraryEntry, 'builtIn' | 'value'>): string {
  if (rubric.builtIn) {
    return rubric.value
  }
  const name = rubric.value.startsWith(SAVED_RUBRIC_PREFIX)
    ? rubric.value.slice(SAVED_RUBRIC_PREFIX.length)
    : rubric.value
  return `${SAVED_RUBRIC_PREFIX}${createHash('sha256').update(name, 'utf8').digest('hex')}`
}

/** Closed answers with their full distributions; question text, legends and the vendor
 * confidence field never reach the ledger. */
function ledgerAnswers(
  answers: Record<string, DecisionAnswer | JevTrialAnswer>
): Record<string, JevCallAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]): [string, JevCallAnswer] => [
      id,
      answer.type === 'noul'
        ? { type: 'noul', noul: answer.noul }
        : answer.type === 'choice'
          ? { type: 'choice', choice: answer.choice, probabilities: { ...answer.probabilities } }
          : { type: 'score', score: answer.score, probabilities: { ...answer.probabilities } }
    ])
  )
}

const ledgerUsage = (usage: { inputTokens: number; outputTokens: number } | undefined) =>
  usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : null

type AttemptRequest = Pick<DecisionRequest, 'capability'> & Partial<DecisionRequest>

/** Routines, ad routines and orchestration shadows: the capability is the caller. */
export const serviceJevCall = (capability: string, deadlineMs: number): DecisionCallTag => ({
  caller: capability,
  transport: 'service',
  deadlineMs
})

/**
 * One in-app call attempt (`jev-call:<id>`). The row is queued when the attempt settles and the
 * caller never waits for it; nothing here can throw into the JEV call.
 */
export function startJevCallAttempt(request: AttemptRequest, tag: DecisionCallTag) {
  const requestId = randomUUID()
  const observedAt = new Date().toISOString()
  const started = performance.now()
  let dispatched = false
  const settle = (result: DecisionResult | undefined, reason: string | null): void => {
    const ledger = jevCallLedger()
    if (!ledger) {
      return
    }
    let fields: JevCallFields
    try {
      fields = {
        record_key: `jev-call:${requestId}`,
        request_id: requestId,
        observed_at: observedAt,
        caller: tag.caller,
        transport: tag.transport,
        deadline_ms: tag.deadlineMs,
        // Why: missing values are null, never estimated; only an answer names its model.
        model: result ? result.model : null,
        ref: request.capability,
        ref_hash: hashOf(request.questions),
        input_hash: hashOf(request.state),
        question_ids: request.questions ? Object.keys(request.questions) : [],
        status: null,
        provider_status: result ? 'evaluated' : dispatched ? 'unavailable' : 'not_called',
        kind: null,
        reason,
        answers: result ? ledgerAnswers(result.answers) : {},
        usage: ledgerUsage(result?.usage),
        elapsed_ms: rounded(performance.now() - started),
        calls: dispatched ? 1 : 0
      }
    } catch {
      ledger.countFailure()
      return
    }
    void ledger.appendCall(fields)
  }
  return {
    dispatching(): void {
      dispatched = true
    },
    evaluated(result: DecisionResult): void {
      settle(result, null)
    },
    /**
     * The provider reports every abort as `cancelled`. The row keeps the caller's own reason
     * (a deadline aborts with `timeout`); the error the caller receives is unchanged.
     */
    failed(error: unknown, signal?: AbortSignal): void {
      const code = error instanceof DecisionProviderError ? error.code : 'provider_error'
      const reason: unknown = signal?.aborted ? signal.reason : undefined
      settle(
        undefined,
        code === 'cancelled' && reason instanceof DecisionProviderError ? reason.code : code
      )
    }
  }
}

/** A caller that never reached the provider (environment kill, no key): still one row. */
export function recordJevNotCalled(
  request: AttemptRequest,
  tag: DecisionCallTag,
  reason: DecisionFailureCode
): void {
  startJevCallAttempt(request, tag).failed(new DecisionProviderError(reason))
}

export type JevRecipeCall = {
  calls: number
  providerStatus: JevProviderStatus
  questionIds: string[]
  refHash: string | null
}

/** A recipe call row: `jev-request:<id>` for `omni jev request`, `jev-call:<id>` for trials. */
export function recipeCallFields(
  identity: {
    recordKey: string
    requestId: string
    observedAt: string
    caller: string
    status: string | null
    recipeRef: string
  },
  result: JevTrialResult,
  call: JevRecipeCall
): JevCallFields {
  return {
    record_key: identity.recordKey,
    request_id: identity.requestId,
    observed_at: identity.observedAt,
    caller: identity.caller,
    transport: 'advisory',
    deadline_ms: DECISION_MAX_TIMEOUT_MS,
    model: result.status === 'success' ? result.model : null,
    ref: identity.recipeRef,
    ref_hash: call.refHash,
    input_hash: result.inputHash,
    question_ids: call.questionIds,
    status: identity.status,
    provider_status: call.calls === 0 ? 'not_called' : call.providerStatus,
    kind: null,
    reason: result.status === 'unavailable' ? result.reason : null,
    answers: ledgerAnswers(result.answers),
    usage: result.status === 'success' ? ledgerUsage(result.usage) : null,
    elapsed_ms: rounded(result.elapsedMs),
    calls: call.calls
  }
}

/** The rubric record decides status, kind and reason; the row keeps them beside its hashes. */
export function rubricCallFields(record: JevRubricEvaluationRecord): JevCallFields {
  return {
    record_key: `jev-rubric:${record.request_id}`,
    request_id: record.request_id,
    observed_at: record.observed_at,
    caller: 'jev.rubrics.evaluate',
    transport: 'advisory',
    deadline_ms: DECISION_MAX_TIMEOUT_MS,
    model: record.calls > 0 && record.provider_status === 'evaluated' ? record.model : null,
    ref: rubricRef(record.rubric),
    ref_hash: record.rubric_hash,
    input_hash: record.input_hash,
    question_ids: ['availability', 'quality', ...record.criteria.map(({ id }) => id)],
    status: record.status,
    provider_status: record.calls === 0 ? 'not_called' : record.provider_status,
    kind: record.kind ?? null,
    reason: record.reason ?? null,
    answers: ledgerAnswers(record.answers),
    usage: ledgerUsage(record.usage),
    elapsed_ms: rounded(record.elapsed_ms),
    calls: record.calls
  }
}
