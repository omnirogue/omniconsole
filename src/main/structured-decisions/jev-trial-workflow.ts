import { createHash, randomUUID } from 'node:crypto'
import type { JevRequestRecipeId, JevTrialResult } from '../../shared/jev-trial-workflow'
import { buildRecipeRequest, recipeDisposition } from '../../../config/scripts/decision-recipes.mjs'
import { evaluateJevAdvisoryRequest, type JevAdvisoryOptions } from './jev-advisory-request'
import { hashOf, recipeCallFields, type JevRecipeCall } from './jev-call-rows'
import { jevCallLedger } from './jev-ledger'

/** The result plus what the ledger row needs: whether the provider was called and which questions. */
export async function runJevTrialWorkflow(
  recipeId: JevRequestRecipeId,
  state: Record<string, string>,
  options: JevAdvisoryOptions = {}
): Promise<{ result: JevTrialResult; call: JevRecipeCall }> {
  const inputHash = createHash('sha256').update(JSON.stringify({ recipeId, state })).digest('hex')
  const request = buildRecipeRequest(recipeId, state, 1)
  const response = await evaluateJevAdvisoryRequest(request, options)
  const call: JevRecipeCall = {
    calls: response.calls,
    providerStatus: response.status === 'evaluated' ? 'evaluated' : 'unavailable',
    questionIds: Object.keys(request.questions),
    refHash: hashOf(request.questions)
  }
  const unavailable = (reason: string): JevTrialResult => ({
    status: 'unavailable',
    disposition: 'review',
    reason,
    elapsedMs: response.elapsedMs,
    inputHash,
    answers: {}
  })
  if (response.status === 'unavailable') {
    return { result: unavailable(response.reason), call }
  }
  const { decision } = response
  const disposition = recipeDisposition(recipeId, decision.answers, 1)
  if (disposition !== 'advisory' && disposition !== 'review') {
    return { result: unavailable('invalid_response'), call }
  }
  return {
    result: {
      status: 'success',
      disposition,
      model: decision.model,
      elapsedMs: response.elapsedMs,
      inputHash,
      answers: decision.answers,
      usage: decision.usage
    },
    call
  }
}

/** The parked desktop trial: no stored record, but still one `jev-call/1` ledger row. */
export async function evaluateJevTrialWorkflow(
  recipeId: JevRequestRecipeId,
  state: Record<string, string>,
  options: JevAdvisoryOptions = {}
): Promise<JevTrialResult> {
  const requestId = randomUUID()
  const observedAt = new Date().toISOString()
  const { result, call } = await runJevTrialWorkflow(recipeId, state, options)
  const identity = {
    recordKey: `jev-call:${requestId}`,
    requestId,
    observedAt,
    caller: 'jev.trial',
    status: null,
    recipeRef: `${recipeId}@1`
  }
  void jevCallLedger()?.appendCall(recipeCallFields(identity, result, call))
  return result
}
