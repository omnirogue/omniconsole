import { normalizeSessionReviewLoopState } from './session-chain-review'
import { normalizeSessionOutcomeSet } from './session-outcome-state'
import { parseExecutionHostId } from './execution-host'
import {
  optionalString,
  readPlanVersion,
  readPlanVersions,
  readVerdictReceipt
} from './session-chain-record-fields'
export { normalizeSessionChainRound } from './session-chain-record-fields'
import { normalizeSessionChainStep } from './session-chain-step-normalize'
export { normalizeSessionChainStep } from './session-chain-step-normalize'
import {
  quarantineChain,
  readQuarantine,
  usesRunLifecycleFields,
  usesWorkPlanFields,
  type ChainLoad,
  type SessionChainLoadReport,
  type SessionChainUnloadable
} from './session-chain-quarantine'
export { isQuarantinedSessionChain } from './session-chain-quarantine'
export type { SessionChainLoadReport, SessionChainUnloadable } from './session-chain-quarantine'
import type {
  SessionChain,
  SessionChainState,
  SessionChainStep,
  SessionChainUnloadableReason,
  SessionChainVerdictReceipt
} from './session-chain-types'
import type { SessionChainTeamPlanning } from './next-outcome-team-plan-schema'

/**
 * The version of the chain record on disk. Absent means 1 — every chain written before the work-plan
 * fields existed. A build stamps its own version only on a chain that carries a field that version
 * introduced, so a plain chain stays readable by an older OmniConsole byte for byte. A record whose
 * version is newer than this build's is never loaded and never rewritten; see `normalizeSessionChains`.
 */
export const SESSION_CHAIN_SCHEMA_VERSION = 2
/**
 * Stamped only on a chain that carries a run-lifecycle record (seal, disposition, requests, block
 * classes, failure codes), so every other plan stays readable by a build that predates them.
 */
export const SESSION_CHAIN_RUN_LIFECYCLE_SCHEMA_VERSION = 3
/** A launched tab is a receipt, so older builds must not discard it and relaunch the step. */
export const SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION = 4

function normalizeTeamPlanning(value: unknown): SessionChainTeamPlanning | undefined {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  return record?.source === 'agent-planned' &&
    typeof record.consentedAt === 'string' &&
    !Number.isNaN(Date.parse(record.consentedAt)) &&
    typeof record.committedAt === 'number' &&
    Number.isFinite(record.committedAt)
    ? { source: 'agent-planned', consentedAt: record.consentedAt, committedAt: record.committedAt }
    : undefined
}

/** Reading a chain back from disk: every field is proven, and an unknown shape is dropped. */
const CHAIN_STATES: readonly SessionChainState[] = [
  'waiting',
  'ready',
  'launching',
  'done',
  'cancelled',
  'failed'
]

function loadSessionChain(value: unknown): ChainLoad {
  if (!value || typeof value !== 'object') {
    return { chain: null, refusal: null }
  }
  const record = value as Record<string, unknown>
  const quarantined = readQuarantine(record.quarantine)
  if (quarantined) {
    // Why: a build that can read the refused record again unwraps it, so a repair or an upgrade
    // brings the plan back instead of leaving it quarantined forever.
    const recovered = loadSessionChain(quarantined.record)
    if (recovered.chain && !recovered.refusal) {
      return recovered
    }
    return {
      chain: quarantineChain(record, quarantined),
      // Why not the quarantine itself: the report is what a person is shown; the refused record
      // belongs on disk, not in a notice.
      refusal: { reason: quarantined.reason, detail: quarantined.detail }
    }
  }
  const version = record.schemaVersion
  if (
    version !== undefined &&
    (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
  ) {
    return refuse(
      record,
      'newer-schema',
      'This plan records a version this OmniConsole cannot read.'
    )
  }
  if (typeof version === 'number' && version > SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION) {
    return refuse(
      record,
      'newer-schema',
      `This plan was written by OmniConsole plan version ${version}; this build reads ${SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION}.`
    )
  }
  const id = optionalString(record.id)
  const workspacePath = optionalString(record.workspacePath)
  const worktreeId = optionalString(record.worktreeId)
  const sourcePaneKey = optionalString(record.sourcePaneKey)
  const sourceRowKey = optionalString(record.sourceRowKey)
  if (!id || !workspacePath || !worktreeId || !sourcePaneKey || !sourceRowKey) {
    // Why: a record with no identity names no work; there is nothing to preserve or repair.
    return { chain: null, refusal: null }
  }
  const reviewLoop =
    record.reviewLoop === undefined ? undefined : normalizeSessionReviewLoopState(record.reviewLoop)
  if (record.reviewLoop !== undefined && !reviewLoop) {
    return refuse(
      record,
      'invalid-outcome-set',
      "This plan's review state is not readable by this build."
    )
  }
  const outcomeSet =
    record.outcomeSet === undefined ? undefined : normalizeSessionOutcomeSet(record.outcomeSet)
  if (record.outcomeSet !== undefined && !outcomeSet) {
    return refuse(
      record,
      'invalid-outcome-set',
      "This plan's committed outcomes are not readable by this build."
    )
  }
  const verdicts =
    record.verdicts === undefined
      ? undefined
      : Array.isArray(record.verdicts)
        ? record.verdicts.map(readVerdictReceipt)
        : undefined
  if (record.verdicts !== undefined && (!verdicts || verdicts.some((entry) => !entry))) {
    return refuse(
      record,
      'invalid-outcome-set',
      "This plan's verdict receipts are not readable by this build."
    )
  }
  const plan = record.planVersion === undefined ? undefined : readPlanVersion(record.planVersion)
  if (record.planVersion !== undefined && !plan) {
    return refuse(
      record,
      'invalid-step',
      'This plan records a plan version this build cannot read.'
    )
  }
  const planVersions =
    record.planVersions === undefined ? undefined : readPlanVersions(record.planVersions)
  if (record.planVersions !== undefined && !planVersions) {
    return refuse(
      record,
      'invalid-step',
      "This plan's version history is not readable by this build."
    )
  }
  const problems: string[] = []
  const rawSteps = Array.isArray(record.steps) ? record.steps : []
  const read = rawSteps.map((step) => normalizeSessionChainStep(step, problems))
  if (problems.length) {
    return refuse(record, 'invalid-step', problems.join('; '))
  }
  if (
    rawSteps.some(
      (step, index) =>
        step && typeof step === 'object' && 'openrouterCandidates' in step && !read[index]
    )
  ) {
    return refuse(record, 'invalid-step', 'A step names a model route this build cannot read.')
  }
  const steps = read.filter((step): step is SessionChainStep => !!step)
  // Why: a committed plan advances by step id, and a missing step is SKIPPED by the selector — the
  // barrier is jumped and the outcome can never satisfy. Refuse the whole chain instead.
  if (outcomeSet && steps.length !== read.length) {
    return refuse(record, 'invalid-step', 'A step of this committed plan could not be read.')
  }
  const owned = new Set(steps.map((step) => step.id))
  const missing = (outcomeSet?.outcomes ?? [])
    .flatMap((outcome) => outcome.stepIds ?? [])
    .find((stepId) => !owned.has(stepId))
  if (missing) {
    return refuse(
      record,
      'invalid-step',
      `This plan's outcome names a step (${missing}) it has lost.`
    )
  }
  // Why: "end this session when it finishes" has nothing to launch; every other plan needs a step,
  // and a plan whose steps this build could not read is dropped, never turned into an ending.
  const endsOnly = record.end === 'done' && rawSteps.length === 0
  if (steps.length === 0 && !endsOnly && !outcomeSet) {
    return { chain: null, refusal: null }
  }
  const parallelOutcomeIds = Array.isArray(record.parallelOutcomeIds)
    ? record.parallelOutcomeIds.filter((entry): entry is string => Boolean(optionalString(entry)))
    : []
  const currentIndex =
    typeof record.currentIndex === 'number' && Number.isInteger(record.currentIndex)
      ? Math.min(Math.max(record.currentIndex, 0), steps.length)
      : 0
  const state = CHAIN_STATES.includes(record.state as SessionChainState)
    ? (record.state as SessionChainState)
    : 'waiting'
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
  const receipts = verdicts as SessionChainVerdictReceipt[] | undefined
  // Why: stamp this build's version only on a chain that uses a field this version introduced, so
  // every plan written before them stays byte-identical on disk and readable by an older build.
  const schemaVersion = steps.some((step) => step.kind !== 'handoff' && step.launchedTabId)
    ? SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION
    : usesRunLifecycleFields(outcomeSet ?? undefined)
      ? SESSION_CHAIN_RUN_LIFECYCLE_SCHEMA_VERSION
      : usesWorkPlanFields({
            steps,
            verdicts: receipts,
            planVersion: plan,
            planVersions,
            // Why the coalesce: the refusal above reads `record.outcomeSet`, which does not narrow this.
            outcomeSet: outcomeSet ?? undefined
          })
        ? SESSION_CHAIN_SCHEMA_VERSION
        : typeof version === 'number'
          ? version
          : undefined
  return {
    chain: {
      id,
      workspacePath,
      worktreeId,
      hostId: optionalString(record.hostId) ?? null,
      sourcePaneKey,
      sourceRowKey,
      auto: record.auto === true,
      ...(record.end === 'me' || record.end === 'done' ? { end: record.end } : {}),
      ...(typeof record.placement === 'string' && parseExecutionHostId(record.placement)
        ? { placement: parseExecutionHostId(record.placement)!.id }
        : {}),
      ...(optionalString(record.sourceWorktreeId)
        ? { sourceWorktreeId: optionalString(record.sourceWorktreeId) }
        : {}),
      steps,
      ...(outcomeSet ? { outcomeSet } : {}),
      ...(outcomeSet && normalizeTeamPlanning(record.teamPlanning)
        ? { teamPlanning: normalizeTeamPlanning(record.teamPlanning) }
        : {}),
      ...(receipts ? { verdicts: receipts } : {}),
      ...(plan ? { planVersion: plan } : {}),
      ...(planVersions ? { planVersions } : {}),
      ...(parallelOutcomeIds.length ? { parallelOutcomeIds } : {}),
      ...(reviewLoop ? { reviewLoop } : {}),
      currentIndex,
      // Why: a chain persisted mid-launch cannot know whether the launch happened; on
      // load it goes back to waiting on its source so nothing starts twice.
      state: state === 'launching' ? 'waiting' : state,
      ...(optionalString(record.error) ? { error: optionalString(record.error) } : {}),
      ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      createdAt,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : createdAt
    },
    refusal: null
  }
}

function refuse(
  record: Record<string, unknown>,
  reason: SessionChainUnloadableReason,
  detail: string
): ChainLoad {
  return { chain: quarantineChain(record, { reason, detail, record }), refusal: { reason, detail } }
}

export function normalizeSessionChain(value: unknown): SessionChain | null {
  const load = loadSessionChain(value)
  return load.refusal ? null : load.chain
}

/**
 * Reads the persisted chain list. A record this build refuses is never dropped: it stays in the list
 * as an inert quarantine entry carrying the original record, so the next whole-state save writes it
 * back untouched, and it is reported so the person can be told which plan needs what.
 */
export function normalizeSessionChainsWithReport(value: unknown): SessionChainLoadReport {
  if (!Array.isArray(value)) {
    return { chains: [], unloadable: [] }
  }
  const seen = new Set<string>()
  const chains: SessionChain[] = []
  const unloadable: SessionChainUnloadable[] = []
  for (const entry of value) {
    const load = loadSessionChain(entry)
    if (!load.chain || seen.has(load.chain.id)) {
      continue
    }
    seen.add(load.chain.id)
    chains.push(load.chain)
    if (load.refusal) {
      unloadable.push({ id: load.chain.id, ...load.refusal })
    }
  }
  return { chains, unloadable }
}

export function normalizeSessionChains(value: unknown): SessionChain[] {
  return normalizeSessionChainsWithReport(value).chains
}

/** Chains a person can still act on; finished ones are kept for the record but not resumed. */
