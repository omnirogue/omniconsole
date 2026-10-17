import { createHash, randomUUID } from 'node:crypto'
import type { JevRequestControl, JevRequestInput } from '../../shared/jev-control'
import type { JevTrialResult } from '../../shared/jev-trial-workflow'
import { buildRecipeRequest } from '../../../config/scripts/decision-recipes.mjs'
import type { JevAdvisoryOptions } from './jev-advisory-request'
import { hashOf, type JevRecipeCall } from './jev-call-rows'
import { runJevTrialWorkflow } from './jev-trial-workflow'

export const JEV_REQUEST_RECORD_SCHEMA = 'jev-request-record/1'

export type JevRequestRecord = {
  schema_version: typeof JEV_REQUEST_RECORD_SCHEMA
  request_id: string
  observed_at: string
  recipe_ref: string
  control: { requested: JevRequestControl; effective: 'off' | 'on' }
  confidence_origin: 'native-typesafe' | 'unavailable'
  decision_escalation: 'never'
  action_authorized: false
  result: JevTrialResult
}

/** One advisory recipe call; off or host-disabled requests are recorded without a provider call. */
export async function evaluateJevRequest(
  input: JevRequestInput,
  options: JevAdvisoryOptions & { control: JevRequestControl }
): Promise<{ record: JevRequestRecord; call: JevRecipeCall }> {
  const { control, ...advisory } = options
  const request_id = randomUUID()
  const observed_at = new Date().toISOString()
  const off = advisory.disabled === true || control === 'off'
  const { result, call } = off
    ? {
        result: {
          status: 'unavailable',
          disposition: 'review',
          reason: 'disabled',
          elapsedMs: 0,
          inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
          answers: {}
        } satisfies JevTrialResult,
        call: notCalled(input)
      }
    : await runJevTrialWorkflow(input.recipeId, input.state, advisory)
  return {
    record: {
      schema_version: JEV_REQUEST_RECORD_SCHEMA,
      request_id,
      observed_at,
      recipe_ref: `${input.recipeId}@1`,
      control: { requested: control, effective: off ? 'off' : 'on' },
      confidence_origin: result.status === 'success' ? 'native-typesafe' : 'unavailable',
      decision_escalation: 'never',
      action_authorized: false,
      result
    },
    call
  }
}

function notCalled(input: JevRequestInput): JevRecipeCall {
  let questions: Record<string, unknown> | undefined
  try {
    questions = buildRecipeRequest(input.recipeId, input.state, 1).questions
  } catch {
    questions = undefined
  }
  return {
    calls: 0,
    providerStatus: 'not_called',
    questionIds: questions ? Object.keys(questions) : [],
    refHash: hashOf(questions)
  }
}
