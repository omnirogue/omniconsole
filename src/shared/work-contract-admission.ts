import { createHash } from 'node:crypto'
import {
  DOCUMENT_KINDS,
  WORK_CONTRACT_FIELDS,
  WorkContractV2,
  type AcceptanceKind,
  type DeliverableKind,
  type WorkContract
} from './work-contract-v2-schema'

export { WorkContractV2, type WorkContract } from './work-contract-v2-schema'

const ALL_KINDS: ReadonlySet<DeliverableKind> = new Set([
  'software_change',
  'configuration_change',
  ...DOCUMENT_KINDS
])
// Which deliverable kinds each acceptance check can prove (Python CHECK_KINDS).
const CHECK_KINDS: Record<AcceptanceKind, ReadonlySet<DeliverableKind>> = {
  required_checks: new Set(['software_change']),
  behavior_check: new Set(['software_change', 'configuration_change']),
  pr_open: new Set(['software_change']),
  pr_preview: new Set(['software_change']),
  config_readback: new Set(['configuration_change']),
  test_event: new Set(['configuration_change']),
  artifact_published: DOCUMENT_KINDS,
  source_grounding: DOCUMENT_KINDS,
  human_review: ALL_KINDS
}
const PROOF_CHECKS: Partial<Record<DeliverableKind, readonly AcceptanceKind[]>> = {
  software_change: ['behavior_check', 'required_checks'],
  configuration_change: ['config_readback', 'test_event']
}
const LINE_COUNT =
  /\b(?:minimum|at least|min\.?|no fewer than)\s+(?:of\s+)?\d+\s+lines?\b|\b\d+\+?\s*lines?\s+(?:minimum|long)\b/i
const DOCUMENT_ONLY_EXT = ['.md', '.markdown', '.txt', '.doc', '.docx', '.pdf', '.html']

export const WORK_CONTRACT_PROBLEM_CODES = [
  'deliverable_downgrade',
  'deliverable_mismatch',
  'acceptance_kind_mismatch',
  'target_required',
  'no_implementation_workspace',
  'check_subject_mismatch',
  'line_count_acceptance',
  'needs_classification'
] as const
export type WorkContractProblemCode = (typeof WORK_CONTRACT_PROBLEM_CODES)[number]
export type WorkContractProblem = { code: WorkContractProblemCode; message: string }

/** Pre-spawn refusals; each one started nothing. */
export const WORK_CONTRACT_REFUSAL_CODES = [
  'work_contract_required',
  'invalid_work_contract',
  ...WORK_CONTRACT_PROBLEM_CODES
] as const
export type WorkContractRefusalCode = (typeof WORK_CONTRACT_REFUSAL_CODES)[number]

const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(WORK_CONTRACT_FIELDS)

export type WorkContractParse =
  | { ok: true; contract: WorkContract }
  | { ok: false; message: string }

/** A validated, normalized copy of a v2 contract, or the first thing to change. */
export function parseWorkContract(value: unknown): WorkContractParse {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const extra = Object.keys(value)
      .filter((key) => !TOP_LEVEL_FIELDS.has(key))
      .sort()
    if (extra.length) {
      return { ok: false, message: `contract has unsupported fields: ${extra.join(', ')}` }
    }
  }
  const parsed = WorkContractV2.safeParse(value)
  return parsed.success
    ? { ok: true, contract: parsed.data }
    : { ok: false, message: parsed.error.issues[0]?.message ?? 'contract is invalid' }
}

/** Each problem that keeps this contract from reaching its own outcome (Python consistency_problems). */
export function workContractProblems(contract: WorkContract): WorkContractProblem[] {
  const problems: WorkContractProblem[] = []
  const kind = contract.deliverable_kind
  const root = contract.root.kind
  const checks = contract.acceptance
  const kinds = new Set(checks.map((check) => check.kind))
  const useful = checks.filter(
    (check) => CHECK_KINDS[check.kind].has(kind) && check.kind !== 'human_review'
  )
  if (contract.role === 'deliver' && kind !== root) {
    problems.push({
      code: 'deliverable_downgrade',
      message: `This contract delivers ${kind} but its root asks for ${root}. A different deliverable is a contract amendment the person approves, never a fallback.`
    })
  }
  const proof = PROOF_CHECKS[kind]
  if (proof && !proof.some((check) => kinds.has(check))) {
    problems.push({
      code: 'deliverable_mismatch',
      message: `A ${kind} needs at least one of ${proof.join(', ')}; documents, files or line counts cannot prove it.`
    })
  } else if (useful.length === 0 && !kinds.has('human_review')) {
    problems.push({
      code: 'deliverable_mismatch',
      message: `None of the acceptance checks can prove a ${kind}.`
    })
  }
  const offKind = [
    ...new Set(checks.filter((c) => !CHECK_KINDS[c.kind].has(kind)).map((c) => c.kind))
  ]
  if (offKind.length && contract.role !== 'verify') {
    problems.push({
      code: 'acceptance_kind_mismatch',
      message: `Checks ${offKind.sort().join(', ')} cannot prove a ${kind}.`
    })
  }
  if (kind === 'software_change') {
    if (!contract.target?.repo) {
      problems.push({
        code: 'target_required',
        message: 'A software change names target.repo and target.base.'
      })
    }
    const owned = contract.scope.owned_paths
    if (
      owned.length &&
      owned.every((path) => DOCUMENT_ONLY_EXT.some((ext) => path.toLowerCase().endsWith(ext)))
    ) {
      problems.push({
        code: 'no_implementation_workspace',
        message:
          'Every owned path is a document, so the work cannot be implemented. Name the code it may change (a worktree or preview branch is allowed).'
      })
    }
    if (
      checks.some(
        (check) =>
          check.kind === 'required_checks' &&
          check.subject !== undefined &&
          check.subject !== 'candidate_commit'
      )
    ) {
      problems.push({
        code: 'check_subject_mismatch',
        message: 'required_checks run against the candidate commit.'
      })
    }
  }
  if (checks.some((check) => LINE_COUNT.test(`${check.expected ?? ''} ${check.command ?? ''}`))) {
    problems.push({
      code: 'line_count_acceptance',
      message:
        'Line counts are not a success condition; name what the document must contain or prove instead.'
    })
  }
  if (contract.root.source === 'inferred') {
    problems.push({
      code: 'needs_classification',
      message: `The root kind ${root} was inferred, not confirmed by a person. Show the kind in a decision page and launch under that decision.`
    })
  }
  return problems
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The runtime's own record digest; the BFF digest may differ (e.g. Python renders 5.0 for a float). */
export function workContractDigest(contract: WorkContract): string {
  return createHash('sha256').update(sortedJson(contract)).digest('hex')
}

export type WorkContractAdmissionMode = 'off' | 'shadow' | 'enforce'

export function workContractAdmissionMode(
  env: Record<string, string | undefined> = process.env
): WorkContractAdmissionMode {
  const value = env.OMNI_WORK_CONTRACT_ADMISSION?.trim().toLowerCase()
  return value === 'off' || value === 'enforce' ? value : 'shadow'
}

export type AgentLaunchClassification = 'interactive' | 'unattended' | 'hub_admitted'

export type AgentLaunchShape = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'draft'
  presentation?: 'background' | 'focused'
}

/**
 * Transport facts only: a caller-supplied launchCause cannot make a launch interactive.
 * The mobile actor is the person lane; an omitted promptDelivery auto-submits.
 */
export function classifyAgentLaunch(input: {
  params: AgentLaunchShape
  actorKind: string | undefined
  hubAdmitted: boolean
}): AgentLaunchClassification {
  if (input.hubAdmitted) {
    return 'hub_admitted'
  }
  if (input.actorKind === 'mobile') {
    return 'interactive'
  }
  const autoSubmits =
    Boolean(input.params.prompt?.trim()) && input.params.promptDelivery !== 'draft'
  return autoSubmits || input.params.presentation === 'background' ? 'unattended' : 'interactive'
}

export type WorkAdmission = {
  status: 'interactive' | 'hub_admitted' | 'contracted' | 'uncontracted'
  mode: WorkContractAdmissionMode
  contractDigest?: string
  workRef?: string
  deliverableKind?: DeliverableKind
  /** A direct-RPC contract names authority the runtime cannot check. */
  authorityVerified?: false
  problems?: WorkContractProblem[]
}

export type AgentLaunchAdmission = {
  admitted: boolean
  code?: WorkContractRefusalCode
  message?: string
  workAdmission: WorkAdmission
}

const GOVERNED_LAUNCH_HINT =
  "Launch governed work through OmniOS (launch_ai_sessions_batch or a work run), which checks the person's decision before any session starts. This request started nothing."

export function admitAgentLaunch(input: {
  classification: AgentLaunchClassification
  contract: unknown
  mode: WorkContractAdmissionMode
}): AgentLaunchAdmission {
  const { classification, mode } = input
  const baseStatus =
    classification === 'unattended' ? 'uncontracted' : (classification as WorkAdmission['status'])
  if (mode === 'off' || input.contract === undefined) {
    if (mode === 'enforce' && classification === 'unattended') {
      return {
        admitted: false,
        code: 'work_contract_required',
        message: `This launch runs unattended and carries no work contract. ${GOVERNED_LAUNCH_HINT}`,
        workAdmission: { status: 'uncontracted', mode }
      }
    }
    return { admitted: true, workAdmission: { status: baseStatus, mode } }
  }
  const parsed = parseWorkContract(input.contract)
  if (!parsed.ok) {
    return {
      admitted: false,
      code: 'invalid_work_contract',
      message: `The work contract is invalid: ${parsed.message}. Correct it and retry; this request started nothing.`,
      workAdmission: { status: baseStatus, mode }
    }
  }
  const contract = parsed.contract
  const problems = workContractProblems(contract)
  const workAdmission: WorkAdmission = {
    status: classification === 'unattended' ? 'contracted' : classification,
    mode,
    contractDigest: workContractDigest(contract),
    workRef: contract.work_ref,
    deliverableKind: contract.deliverable_kind,
    ...(classification === 'unattended' ? { authorityVerified: false as const } : {}),
    ...(problems.length ? { problems } : {})
  }
  if (problems.length) {
    return {
      admitted: false,
      code: problems[0].code,
      message: `${problems.map((problem) => problem.message).join(' ')} This request started nothing.`,
      workAdmission
    }
  }
  if (mode === 'enforce' && classification === 'unattended') {
    return {
      admitted: false,
      code: 'work_contract_required',
      message: `This unattended launch carries a contract, but its authority cannot be verified on a direct runtime call. ${GOVERNED_LAUNCH_HINT}`,
      workAdmission
    }
  }
  return { admitted: true, workAdmission }
}
