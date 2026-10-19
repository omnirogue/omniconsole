import { z } from 'zod'

// Mirrors parse_contract in omnirogue/omni-console bff/omni_bff/work_contract.py; keep names and enums identical.

export const WORK_CONTRACT_SCHEMA_VERSION = 2
export const DELIVERABLE_KINDS = [
  'software_change',
  'configuration_change',
  'report',
  'research',
  'proposal',
  'plan'
] as const
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]
export const DOCUMENT_KINDS: ReadonlySet<DeliverableKind> = new Set([
  'report',
  'research',
  'proposal',
  'plan'
])
export const WORK_ROLES = ['deliver', 'subtask', 'verify'] as const
export const ROOT_SOURCES = [
  'decision',
  'factory_option',
  'delegation',
  'inherited',
  'operator_request',
  'inferred'
] as const
export const AUTHORITY_BASES = ['decision', 'delegation', 'inherited', 'operator_request'] as const
export const ACCEPTANCE_KINDS = [
  'required_checks',
  'behavior_check',
  'pr_open',
  'pr_preview',
  'config_readback',
  'test_event',
  'artifact_published',
  'source_grounding',
  'human_review'
] as const
export type AcceptanceKind = (typeof ACCEPTANCE_KINDS)[number]
export const ACCEPTANCE_SUBJECTS = [
  'candidate_commit',
  'pull_request',
  'preview',
  'account_state',
  'artifact'
] as const

const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i

// Python _text: non-blank, bounded, no NUL; whitespace runs collapse to one space.
const text = (key: string, limit: number) =>
  z
    .string({ error: `contract.${key} must be non-empty text of at most ${limit} characters` })
    .refine((value) => value.trim().length > 0 && value.length <= limit && !value.includes('\0'), {
      message: `contract.${key} must be non-empty text of at most ${limit} characters`
    })
    .transform((value) => value.split(/\s+/).filter(Boolean).join(' '))

const ref = (key: string) =>
  z
    .string({ error: `contract.${key} must be a short identifier (letters, digits, . _ : -)` })
    .regex(REF, `contract.${key} must be a short identifier (letters, digits, . _ : -)`)

const positiveInt = (message: string) => z.number({ error: message }).int(message).min(1, message)

const DecisionRef = (key: string) =>
  z
    .object(
      {
        slug: z.string().regex(SLUG, `contract.authority.${key}.slug must name the decision page`),
        revision: positiveInt(`contract.authority.${key} needs the exact revision and decision_id`),
        decision_id: positiveInt(
          `contract.authority.${key} needs the exact revision and decision_id`
        )
      },
      { error: `contract.authority.${key} names slug, revision and decision_id` }
    )
    .strict()

const Target = z
  .object(
    {
      repo: z.string().regex(REPO, 'contract.target.repo must be owner/name').nullish(),
      base: z.unknown().optional(),
      account: text('target.account', 120).nullish(),
      environment: text('target.environment', 120).nullish()
    },
    { error: 'contract.target accepts repo and base, or account and environment' }
  )
  .strict()
  .superRefine((value, context) => {
    const base = value.base
    if (
      value.repo != null &&
      !(typeof base === 'string' && BRANCH.test(base) && !base.includes('..'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'contract.target.base must name the branch the work starts from'
      })
    }
  })
  .transform((value) => {
    const out: { repo?: string; base?: string; account?: string; environment?: string } = {}
    if (value.repo != null) {
      out.repo = value.repo
      out.base = value.base as string
    }
    if (value.account != null) {
      out.account = value.account
    }
    if (value.environment != null) {
      out.environment = value.environment
    }
    return Object.keys(out).length ? out : null
  })

const Acceptance = z
  .object(
    {
      id: ref('acceptance.id'),
      kind: z.enum(ACCEPTANCE_KINDS, {
        error: `acceptance kind must be one of ${ACCEPTANCE_KINDS.join(', ')}`
      }),
      subject: z
        .enum(ACCEPTANCE_SUBJECTS, {
          error: `acceptance subject must be one of ${ACCEPTANCE_SUBJECTS.join(', ')}`
        })
        .nullish(),
      expected: text('acceptance.expected', 1000).nullish(),
      command: text('acceptance.command', 1000).nullish()
    },
    { error: 'each acceptance check has id, kind and optional subject, expected, command' }
  )
  .strict()
  .transform(({ id, kind, subject, expected, command }) => ({
    id,
    kind,
    ...(subject != null ? { subject } : {}),
    ...(expected != null ? { expected } : {}),
    ...(command != null ? { command } : {})
  }))

const Limits = z
  .object(
    {
      attempts: z
        .number({ error: 'contract.limits.attempts must be 1 to 10' })
        .int('contract.limits.attempts must be 1 to 10')
        .min(1, 'contract.limits.attempts must be 1 to 10')
        .max(10, 'contract.limits.attempts must be 1 to 10')
        .optional(),
      cost_usd: z
        .number({ error: 'contract.limits.cost_usd must be a positive amount up to 10000' })
        .gt(0, 'contract.limits.cost_usd must be a positive amount up to 10000')
        .max(10_000, 'contract.limits.cost_usd must be a positive amount up to 10000')
        .optional(),
      deadline: z
        .string({ error: 'contract.limits.deadline must be an ISO 8601 time' })
        .refine((value) => ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)), {
          message: 'contract.limits.deadline must be an ISO 8601 time with a timezone'
        })
        .transform((value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z'))
        .optional()
    },
    { error: 'contract.limits accepts attempts, cost_usd and deadline' }
  )
  .strict()

const Authority = z
  .object(
    {
      basis: z.enum(AUTHORITY_BASES, {
        error: `contract.authority.basis must be one of ${AUTHORITY_BASES.join(', ')}`
      }),
      decision: z.unknown().optional(),
      delegation: z.unknown().optional(),
      selection_hash: z.unknown().optional(),
      item_key: ref('authority.item_key').nullish(),
      request: z.unknown().optional()
    },
    {
      error: `contract.authority.basis must be one of ${AUTHORITY_BASES.join(', ')}`
    }
  )
  .strict()
  .transform((value, context) => {
    const out: Record<string, unknown> = { basis: value.basis }
    const take = (key: string, schema: z.ZodType, input: unknown): void => {
      const parsed = schema.safeParse(input)
      if (parsed.success) {
        out[key] = parsed.data
      } else {
        context.addIssue({ code: 'custom', message: parsed.error.issues[0].message })
      }
    }
    if (value.basis === 'decision') {
      take('decision', DecisionRef('decision'), value.decision)
      if (value.selection_hash != null) {
        take(
          'selection_hash',
          z.string().regex(SHA256, 'contract.authority.selection_hash must be a sha256 hex digest'),
          value.selection_hash
        )
      }
    } else if (value.basis === 'delegation') {
      take('delegation', DecisionRef('delegation'), value.delegation)
    } else if (value.basis === 'operator_request') {
      take('request', text('authority.request', 2000), value.request)
    }
    if (value.item_key != null) {
      out.item_key = value.item_key
    }
    if (
      (value.basis === 'decision' || value.basis === 'delegation') &&
      out.item_key === undefined &&
      out.selection_hash
    ) {
      context.addIssue({
        code: 'custom',
        message: 'contract.authority.item_key names this item in the approved selection'
      })
    }
    return out
  })

const ROOT_MESSAGE = `contract.root needs kind (a deliverable kind) and source (${ROOT_SOURCES.join(', ')})`
const RootKind = z
  .object(
    {
      kind: z.enum(DELIVERABLE_KINDS, { error: ROOT_MESSAGE }),
      source: z.enum(ROOT_SOURCES, { error: ROOT_MESSAGE })
    },
    { error: ROOT_MESSAGE }
  )
  .strict()

const SCOPE_SIZE = 'contract.scope lists at most 50 owned_paths and 20 excluded_actions'

const Scope = z
  .object(
    {
      owned_paths: z
        .array(text('scope.owned_paths', 300), { error: SCOPE_SIZE })
        .max(50, SCOPE_SIZE)
        .nullish(),
      excluded_actions: z
        .array(text('scope.excluded_actions', 80), { error: SCOPE_SIZE })
        .max(20, SCOPE_SIZE)
        .nullish()
    },
    { error: 'contract.scope accepts owned_paths and excluded_actions' }
  )
  .strict()
  .nullish()
  .transform((value) => ({
    owned_paths: value?.owned_paths ?? [],
    excluded_actions: value?.excluded_actions ?? []
  }))

const CONTRACT_FIELDS = {
  schema_version: z.literal(WORK_CONTRACT_SCHEMA_VERSION, {
    error: 'contract.schema_version must be 2'
  }),
  work_ref: ref('work_ref'),
  contract_revision: positiveInt('contract.contract_revision must be a positive integer'),
  deliverable_kind: z.enum(DELIVERABLE_KINDS, {
    error: `contract.deliverable_kind must be one of ${DELIVERABLE_KINDS.join(', ')}`
  }),
  role: z
    .enum(WORK_ROLES, { error: 'contract.role must be deliver, subtask or verify' })
    .optional()
    .transform((value) => value ?? 'deliver'),
  parent_work_ref: z.union([ref('parent_work_ref'), z.literal(''), z.null()]).optional(),
  root: RootKind,
  requested_outcome: text('requested_outcome', 600),
  target: Target.nullish().transform((value) => value ?? null),
  scope: Scope,
  acceptance: z
    .array(Acceptance, { error: 'contract.acceptance must list 1 to 32 checks' })
    .min(1, 'contract.acceptance must list 1 to 32 checks')
    .max(32, 'contract.acceptance must list 1 to 32 checks'),
  limits: Limits.nullish().transform((value) => value ?? {}),
  authority: Authority
}
export const WORK_CONTRACT_FIELDS = Object.keys(CONTRACT_FIELDS)

/** Shape only; consistency lives in workContractProblems. */
export const WorkContractV2 = z
  .object(CONTRACT_FIELDS, { error: 'contract must be an object' })
  .strict()
  .transform((value, context) => {
    const ids = value.acceptance.map((check) => check.id)
    const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
    if (repeated) {
      context.addIssue({ code: 'custom', message: `acceptance id ${repeated} is listed twice` })
    }
    const parent = value.parent_work_ref || null
    if (value.role !== 'deliver' && !parent) {
      context.addIssue({
        code: 'custom',
        message: 'a subtask or verify contract names its parent_work_ref'
      })
    }
    return { ...value, parent_work_ref: parent }
  })

export type WorkContract = z.infer<typeof WorkContractV2>
