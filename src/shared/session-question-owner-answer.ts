import { z } from 'zod'

export const SESSION_QUESTION_OWNER_ANSWER_CAPABILITY = 'session-question.owner-answer.v1' as const
export const SESSION_QUESTION_OWNER_RPC = {
  read: 'sessionQuestion.read',
  answer: 'sessionQuestion.answer'
} as const

const id = z.string().min(1).max(4096)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
export const SessionQuestionOwnerTargetSchema = z
  .object({ worktreeId: id, paneKey: id, terminal: id })
  .strict()
export const SessionQuestionDisplayedSchema = z
  .object({
    interactivePrompt: z.string().min(1).max(100_000),
    stateStartedAt: z.number().finite().nonnegative(),
    agentType: z.string().min(1).max(64),
    providerSession: z.object({ key: z.enum(['session_id', 'conversation_id']), id }).strict()
  })
  .strict()
export const SessionQuestionOwnerBindingSchema = z
  .object({ runtimeId: id, fingerprint, ownerFingerprint: fingerprint })
  .strict()
export const SessionQuestionOwnerReadParamsSchema = z
  .object({
    runtimeId: id,
    target: SessionQuestionOwnerTargetSchema,
    displayed: SessionQuestionDisplayedSchema
  })
  .strict()
export const SessionQuestionOwnerAnswerParamsSchema = SessionQuestionOwnerReadParamsSchema.extend({
  binding: SessionQuestionOwnerBindingSchema,
  answer: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('choose'), choice: z.number().int().min(1).max(25) }).strict(),
    z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(4000) }).strict()
  ])
})
  .strict()
  .refine((value) => value.runtimeId === value.binding.runtimeId, 'The runtime binding changed.')

const identity = { runtimeId: id, target: SessionQuestionOwnerTargetSchema }
export const SessionQuestionOwnerRefusalSchema = z
  .object({
    ...identity,
    status: z.literal('refused'),
    code: z.enum([
      'provenance-required',
      'unsupported-capability',
      'stale-question',
      'not-eligible'
    ]),
    message: z.string().min(1)
  })
  .strict()
export const SessionQuestionOwnerReadySchema = z
  .object({
    ...identity,
    status: z.literal('ready'),
    binding: SessionQuestionOwnerBindingSchema,
    question: z
      .object({
        text: z.string().min(1),
        options: z.array(
          z.object({ n: z.number().int().min(1).max(25), label: z.string().min(1) }).strict()
        ),
        acceptsText: z.boolean()
      })
      .strict()
  })
  .strict()
export const SessionQuestionOwnerReadResultSchema = z
  .discriminatedUnion('status', [
    SessionQuestionOwnerReadySchema,
    SessionQuestionOwnerRefusalSchema
  ])
  .refine(
    (value) => value.status !== 'ready' || value.runtimeId === value.binding.runtimeId,
    'The runtime binding changed.'
  )
export const SessionQuestionOwnerAnswerResultSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        ...identity,
        status: z.literal('answered'),
        binding: SessionQuestionOwnerBindingSchema,
        delivery: z.enum(['confirmed', 'recorded', 'unconfirmed']),
        summary: z.string().min(1)
      })
      .strict(),
    SessionQuestionOwnerRefusalSchema
  ])
  .refine(
    (value) => value.status !== 'answered' || value.runtimeId === value.binding.runtimeId,
    'The runtime binding changed.'
  )

export type SessionQuestionOwnerReadParams = z.infer<typeof SessionQuestionOwnerReadParamsSchema>
export type SessionQuestionOwnerAnswerParams = z.infer<
  typeof SessionQuestionOwnerAnswerParamsSchema
>
export type SessionQuestionOwnerReadResult = z.infer<typeof SessionQuestionOwnerReadResultSchema>
export type SessionQuestionOwnerAnswerResult = z.infer<
  typeof SessionQuestionOwnerAnswerResultSchema
>
export type SessionQuestionOwnerReady = z.infer<typeof SessionQuestionOwnerReadySchema>
export type SessionQuestionOwnerBinding = z.infer<typeof SessionQuestionOwnerBindingSchema>
export type SessionQuestionOwnerRefusal = z.infer<typeof SessionQuestionOwnerRefusalSchema>
