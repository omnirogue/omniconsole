import { z } from 'zod'

export const jevRequestControlSchema = z.enum(['auto', 'off', 'on', 'request'])
export type JevRequestControl = z.infer<typeof jevRequestControlSchema>

const text = z.string().trim().min(1).max(6000)
const recipe = <const Id extends string, const Shape extends z.ZodRawShape>(
  recipeId: Id,
  state: Shape
) => z.object({ recipeId: z.literal(recipeId), state: z.object(state).strict() }).strict()
const advertisingReview = recipe('advertising_review', { copy: text, offer: text })
const evidenceReview = recipe('evidence_review', { claim: text, source: text })
const workRouting = recipe('work_routing', { task: text })
const withinStateLimit = <T extends z.ZodType<{ state: object }>>(schema: T) =>
  schema.refine(
    ({ state }) => new TextEncoder().encode(JSON.stringify(state)).byteLength <= 12_000,
    { message: 'JEV input exceeds the 12 KB limit.' }
  )

/** The parked desktop trials keep their three recipes; `jev.request` accepts all six. */
export const jevTrialInputSchema = withinStateLimit(
  z.discriminatedUnion('recipeId', [advertisingReview, evidenceReview, workRouting])
)
export const jevRequestInputSchema = withinStateLimit(
  z.discriminatedUnion('recipeId', [
    advertisingReview,
    evidenceReview,
    workRouting,
    recipe('support_triage', { message: text }),
    recipe('retrieval_review', { query: text, passage: text }),
    recipe('lead_fit', { lead: text, criteria: text })
  ])
)
export type JevRequestInput = z.infer<typeof jevRequestInputSchema>

export const jevRequestSchema = z
  .object({
    input: jevRequestInputSchema,
    control: jevRequestControlSchema.default('request')
  })
  .strict()

export const JEV_CONTROL_METHODS = {
  status: 'jev.status',
  configure: 'jev.configure',
  request: 'jev.request'
} as const

export type JevHostStatus = {
  version: 1
  enabled: boolean
  effective: 'on' | 'off'
  configured: boolean
  valid: boolean
  environmentDisabled: boolean
  configurationPath: string
  scope: string
  llmEscalation: string
  pending: number
  credentialConfigured?: boolean
}
