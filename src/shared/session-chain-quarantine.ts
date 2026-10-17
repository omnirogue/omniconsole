import { asRecord, onlyKeys, optionalString } from './session-chain-record-fields'
import type {
  SessionChain,
  SessionChainQuarantine,
  SessionChainUnloadableReason
} from './session-chain-types'

export type SessionChainUnloadable = {
  id: string
  reason: SessionChainUnloadableReason
  detail: string
}

/** What one read of the persisted chain list produced, and what it refused to read. */
export type SessionChainLoadReport = {
  chains: SessionChain[]
  unloadable: SessionChainUnloadable[]
}

export type ChainRefusal = { reason: SessionChainUnloadableReason; detail: string }
/** `chain` is what belongs in the profile state: the loaded chain, or the inert quarantine record. */
export type ChainLoad = { chain: SessionChain | null; refusal: ChainRefusal | null }

const QUARANTINE_MESSAGES: Record<SessionChainUnloadableReason, string> = {
  'invalid-step': 'This plan has a step this OmniConsole cannot read; it needs repair.',
  'invalid-outcome-set': "This plan's committed outcomes are not readable by this OmniConsole.",
  'newer-schema': 'This plan was written by a newer OmniConsole.'
}

export function readQuarantine(value: unknown): SessionChainQuarantine | undefined {
  const record = asRecord(value)
  const detail = record ? optionalString(record.detail) : undefined
  const reason = record?.reason
  return record &&
    onlyKeys(record, ['reason', 'detail', 'record']) &&
    (reason === 'invalid-step' || reason === 'invalid-outcome-set' || reason === 'newer-schema') &&
    detail &&
    record.record !== undefined
    ? { reason, detail, record: record.record }
    : undefined
}

/**
 * The inert record kept in place of a chain this build refused: no steps, no outcomes, never live,
 * carrying the refused record verbatim so the next save cannot delete work this build cannot read.
 * Returns null when even the chain's identity is unreadable — there is nothing to keep or repair.
 */
export function quarantineChain(
  record: Record<string, unknown>,
  quarantine: SessionChainQuarantine
): SessionChain | null {
  const id = optionalString(record.id)
  const workspacePath = optionalString(record.workspacePath)
  const worktreeId = optionalString(record.worktreeId)
  const sourcePaneKey = optionalString(record.sourcePaneKey)
  const sourceRowKey = optionalString(record.sourceRowKey)
  if (!id || !workspacePath || !worktreeId || !sourcePaneKey || !sourceRowKey) {
    return null
  }
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
  return {
    id,
    workspacePath,
    worktreeId,
    hostId: optionalString(record.hostId) ?? null,
    sourcePaneKey,
    sourceRowKey,
    auto: false,
    steps: [],
    currentIndex: 0,
    state: 'failed',
    error: QUARANTINE_MESSAGES[quarantine.reason],
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : createdAt,
    quarantine
  }
}

export function isQuarantinedSessionChain(chain: SessionChain): boolean {
  return Boolean(chain.quarantine)
}

const WORK_PLAN_STEP_FIELDS = [
  'seat',
  'verdict',
  // A gate's fail route is as much a version-2 record as its verdict: a host that drops it runs the
  // plan without the repair branch the person authored.
  'onFail',
  'readsFrom',
  'readsWinnerOf',
  'enabledBy',
  'wait',
  'planNodeId',
  'planVersion',
  'route',
  'writes',
  // The composer's own record of what the person asked for: which stage a seat belongs to,
  // and the prompts they added to that stage. A host that drops either runs a plan that is
  // not the one they composed — the stage reads as its compiled parts, and a prompt they
  // wrote is never sent — so it must refuse the chain instead of half-reading it.
  'stage',
  'prompts'
] as const

/** Seal, disposition, requests, block classes and failure codes: a host that drops one misreads the run. */
export function usesRunLifecycleFields(set: SessionChain['outcomeSet']): boolean {
  return Boolean(
    set &&
    (set.completion !== undefined ||
      set.disposition !== undefined ||
      set.attention !== undefined ||
      set.outcomes.some((outcome) => outcome.block !== undefined) ||
      set.attempts.some(
        (attempt) => attempt.failure !== undefined || attempt.awaiting !== undefined
      ))
  )
}

export function usesWorkPlanFields(
  chain: Pick<SessionChain, 'steps' | 'verdicts' | 'planVersion' | 'planVersions' | 'outcomeSet'>
): boolean {
  return (
    chain.verdicts !== undefined ||
    chain.planVersion !== undefined ||
    chain.planVersions !== undefined ||
    chain.steps.some(
      (step) =>
        step.kind !== 'handoff' &&
        WORK_PLAN_STEP_FIELDS.some(
          (field) => (step as Record<string, unknown>)[field] !== undefined
        )
    ) ||
    // Why the outcome set too: a card filing and a superseded attempt are as much a version-2 record
    // as a seat is, and a host that cannot read them must quarantine the chain, not run it half-read.
    (chain.outcomeSet?.outcomes.some((outcome) => outcome.taskRef !== undefined) ?? false) ||
    (chain.outcomeSet?.attempts.some(
      (attempt) => attempt.planVersion !== undefined || attempt.state === 'superseded'
    ) ??
      false) ||
    (chain.outcomeSet?.outcomes.some((outcome) =>
      outcome.evidence.some((entry) => entry.planVersion !== undefined)
    ) ??
      false)
  )
}
