import { z } from 'zod'
import { decisionIdentifierSchema, type DecisionCallTag } from './structured-decision-contract'

export { JEV_RECORDS_RUNTIME_CAPABILITY } from './protocol-version'

export const JEV_CALL_SCHEMA = 'jev-call/1'
export const JEV_OUTCOME_SCHEMA = 'jev-outcome/1'
export const JEV_RECORD_METHODS = {
  list: 'jev.records.list',
  export: 'jev.records.export',
  outcome: 'jev.outcome'
} as const

export type JevProviderStatus = 'not_called' | 'evaluated' | 'unavailable'
export type JevCallAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
  | { type: 'score'; score: number; probabilities: Record<string, number> }

/** ROW-CONTRACT `jev-call/1`: hashes, ids and closed answers only; never request text. */
export type JevCallRow = {
  schema: typeof JEV_CALL_SCHEMA
  record_key: string
  request_id: string
  observed_at: string
  host: string
  runtime_id: string | null
  caller: string
  transport: DecisionCallTag['transport']
  deadline_ms: number | null
  model: string | null
  ref: string | null
  ref_hash: string | null
  input_hash: string | null
  question_ids: string[]
  status: string | null
  provider_status: JevProviderStatus
  kind: string | null
  reason: string | null
  answers: Record<string, JevCallAnswer>
  usage: { input_tokens: number; output_tokens: number } | null
  elapsed_ms: number | null
  calls: number
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const jevRecordKeySchema = z
  .string()
  .regex(
    new RegExp(`^jev-(?:rubric|request|call):${UUID}$`),
    'Use a record key such as jev-rubric:<request_id> from a JEV result or `omni jev records list`.'
  )

/** Date.parse rolls 2026-02-30 over to March 2; a real time keeps its date and clock fields. */
export function isRealCalendarTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) {
    return false
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0))
  const time = new Date(0)
  time.setUTCFullYear(year, month - 1, day)
  time.setUTCHours(hour, minute, second)
  return (
    time.getUTCFullYear() === year &&
    time.getUTCMonth() === month - 1 &&
    time.getUTCDate() === day &&
    time.getUTCHours() === hour &&
    time.getUTCMinutes() === minute &&
    time.getUTCSeconds() === second
  )
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const jevIsoTimeSchema = z
  .string()
  .regex(ISO_UTC, 'Use an ISO 8601 UTC time such as 2026-10-03T13:00:00Z.')
  .refine(isRealCalendarTime, 'Use a real calendar time.')

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE = /(?<!\d)(?:\+?\d[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)/
// Why: outcome rows are hash-only too; a short label or note never carries contact details.
const shortText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/\p{Cc}/u.test(text), 'Use one line of plain text.')
    .refine(
      (text) => !EMAIL.test(text) && !PHONE.test(text),
      'Remove email addresses and phone numbers; outcome rows never hold contact details.'
    )

/** A session id, or a person as the SHA-256 of their lowercased email; never the email itself. */
const JEV_LABELER = /^(session:[A-Za-z0-9._:-]{1,128}|sha256:[0-9a-f]{64})$/
const JEV_LABELER_HINT =
  'labeler must be session:<session or agent id> or sha256:<lowercase hex SHA-256 of the person’s lowercased email>; a raw email address is never stored.'

export const jevOutcomeInputSchema = z
  .object({
    schema: z.literal(JEV_OUTCOME_SCHEMA).optional(),
    record_key: jevRecordKeySchema.optional(),
    question_id: decisionIdentifierSchema.nullable().default(null),
    label: z.union([shortText(120), z.number().finite(), z.boolean()]),
    evidence_level: z.enum(['ground_truth', 'verification', 'cross_check']),
    source: z.enum(['human', 'verified_outcome', 'model_reference']),
    labeler: z.string().regex(JEV_LABELER, JEV_LABELER_HINT),
    blind: z.boolean(),
    recorded_at: jevIsoTimeSchema.optional(),
    correction_minutes: z.number().finite().min(0).max(1_000_000).nullable().default(null),
    note: shortText(500).nullable().default(null)
  })
  .strict()

export const jevOutcomeParamsSchema = z
  .object({ record_key: jevRecordKeySchema, outcome: jevOutcomeInputSchema })
  .strict()
  .refine(
    ({ record_key, outcome }) =>
      outcome.record_key === undefined || outcome.record_key === record_key,
    'The outcome file names a different record_key.'
  )

/** ROW-CONTRACT `jev-outcome/1`: an independent label, appended separately from predictions. */
export type JevOutcomeRow = {
  schema: typeof JEV_OUTCOME_SCHEMA
  record_key: string
  question_id: string | null
  label: string | number | boolean
  evidence_level: 'ground_truth' | 'verification' | 'cross_check'
  source: 'human' | 'verified_outcome' | 'model_reference'
  labeler: string
  blind: boolean
  recorded_at: string
  correction_minutes: number | null
  note: string | null
}

export const JEV_RECORDS_LIST_MAX = 1000
export const jevRecordsListSchema = z
  .object({
    since: jevIsoTimeSchema.optional(),
    caller: decisionIdentifierSchema.optional(),
    limit: z.number().int().min(1).max(JEV_RECORDS_LIST_MAX).default(50)
  })
  .strict()
export const jevRecordsExportSchema = z
  .object({ since: jevIsoTimeSchema.optional(), cursor: z.string().min(1).max(4096).optional() })
  .strict()
export type JevRecordsListParams = z.input<typeof jevRecordsListSchema>
export type JevRecordsExportParams = z.input<typeof jevRecordsExportSchema>
