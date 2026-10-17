import { z } from 'zod'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
export type DecisionValue = string | JsonValue[] | Record<string, JsonValue>
export const DECISION_MAX_INPUT_BYTES = 64 * 1024
export const DECISION_MAX_RESPONSE_BYTES = 256 * 1024
export const DECISION_MAX_TIMEOUT_MS = 5_000
export const decisionIdentifierSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,96}$/)
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
)
const valueSchema: z.ZodType<DecisionValue> = z.union([
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
])
const instructions = valueSchema
export const decisionQuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      instructions,
      criteria: z
        .record(decisionIdentifierSchema, valueSchema.nullable())
        .refine((v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255)
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      instructions,
      criteria: z.array(valueSchema).min(2).max(10)
    })
    .strict(),
  z
    .object({
      type: z.literal('noul'),
      instructions,
      criteria: z
        .object({ true: valueSchema.optional(), false: valueSchema.optional() })
        .strict()
        .optional()
    })
    .strict()
])
export const decisionQuestionsSchema = z
  .record(decisionIdentifierSchema, decisionQuestionSchema)
  .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64)
export const decisionRequestSchema = z
  .object({
    capability: decisionIdentifierSchema,
    routineId: decisionIdentifierSchema.optional(),
    state: valueSchema,
    questions: decisionQuestionsSchema,
    model: decisionIdentifierSchema.optional()
  })
  .strict()
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>
export type ChoiceQuestion = Extract<DecisionQuestion, { type: 'choice' }>
export type ScoreQuestion = Extract<DecisionQuestion, { type: 'score' }>
export type NoulQuestion = Extract<DecisionQuestion, { type: 'noul' }>
export type DecisionQuestions = z.infer<typeof decisionQuestionsSchema>
export type DecisionRequest = z.infer<typeof decisionRequestSchema>
export type DecisionMode = 'off' | 'shadow' | 'live'
export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score'
      score: number
      legend: Record<string, DecisionValue>
      probabilities: Record<string, number>
      confidence: number
    }
  | { type: 'noul'; noul: number }
export type DecisionResult = {
  provider: string
  model: string
  answers: Record<string, DecisionAnswer>
  usage: { inputTokens: number; outputTokens: number }
  requestId?: string
}
export const decisionFailureCodeSchema = z.enum([
  'disabled',
  'invalid_configuration',
  'not_live',
  'shadow_only',
  'routine_not_enabled',
  'invalid_request',
  'no_api_key',
  'authentication',
  'forbidden',
  'rate_limited',
  'overloaded',
  'timeout',
  'cancelled',
  'network',
  'provider_error',
  'invalid_response',
  'input_too_large',
  'response_too_large',
  'queue_full',
  'disposed'
])
export type DecisionFailureCode = z.infer<typeof decisionFailureCodeSchema>
export class DecisionProviderError extends Error {
  constructor(
    readonly code: DecisionFailureCode,
    readonly retryable = false,
    readonly retryAfterMs?: number
  ) {
    super(decisionFailureCodeSchema.safeParse(code).success ? code : 'provider_error')
    this.name = 'DecisionProviderError'
    this.code = this.message as DecisionFailureCode
    if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
      this.retryAfterMs = undefined
    }
  }
}
/** Who asked and on which transport and deadline: the JEV ledger's cohort for one attempt. */
export type DecisionCallTag = {
  caller: string
  transport: 'advisory' | 'direct' | 'service'
  deadlineMs: number | null
}
export type StructuredDecisionProvider = {
  readonly id: string
  readonly shadowOnly?: boolean
  evaluate(
    request: DecisionRequest,
    options: { signal: AbortSignal; call?: DecisionCallTag }
  ): Promise<DecisionResult>
}
export type DecisionOutcome =
  | { status: 'evaluated'; mode: 'live'; result: DecisionResult }
  | { status: 'disabled' | 'unavailable' | 'cancelled'; reason: DecisionFailureCode }
