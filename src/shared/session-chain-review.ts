import { parseSessionVerdict, type SessionVerdictStatus } from './session-chain-verdict'

// The marker and its one parser live with the verdict envelope now, so a reviewer line and a
// verdict line are read by the same rules; every existing importer still finds the marker here.
export { SESSION_REVIEW_RESULT_MARKER } from './session-chain-verdict'

export type SessionReviewAssignment = {
  groupId: string
  reviewerId: string
  round: number
  maxRounds: number
  repairWithSource?: boolean
  candidateVersion: string
  adversarial?: boolean
  /** Findings with no repair stop the outcome for a decision instead of completing as a report. */
  gate?: boolean
}

export type SessionReviewRepairAssignment = {
  groupId: string
  afterRound: number
  candidateVersion: string
  consumptionKey: string
  withSource?: boolean
}

/**
 * `crashed` is not a verdict: it is the absence of one. The four real statuses are the envelope's
 * (`session-chain-verdict.ts`), so a reviewer that could not judge says so instead of being read as
 * a dead agent, and a verifier that failed says `fail` instead of `findings`.
 */
export type SessionReviewerVerdict = {
  status: SessionVerdictStatus | 'crashed'
  blockingFindings: string[]
  notes?: string
}

export type SessionReviewReceipt = SessionReviewerVerdict & {
  stepId: string
  reviewerId: string
  candidateVersion: string
  recordedAt: number
}

export type SessionReviewRoundState = {
  index: number
  candidateVersion: string
  receipts: SessionReviewReceipt[]
  revisedVersion?: string
}

export type SessionReviewGroupState = {
  id: string
  maxRounds: number
  currentRound: number
  status: 'reviewing' | 'repairing' | 'passed' | 'blocked' | 'report-complete'
  rounds: SessionReviewRoundState[]
  consumedRepairKeys: string[]
}

export type SessionReviewLoopState = { groups: SessionReviewGroupState[] }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function integer(value: unknown, minimum = 1): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : undefined
}

export function normalizeSessionReviewAssignment(
  value: unknown
): SessionReviewAssignment | undefined {
  const raw = record(value)
  const groupId = text(raw?.groupId)
  const reviewerId = text(raw?.reviewerId)
  const round = integer(raw?.round)
  const maxRounds = integer(raw?.maxRounds)
  const candidateVersion = text(raw?.candidateVersion)
  if (!groupId || !reviewerId || !round || !maxRounds || round > maxRounds || !candidateVersion) {
    return undefined
  }
  return {
    groupId,
    reviewerId,
    round,
    maxRounds,
    candidateVersion,
    ...(raw?.repairWithSource === true ? { repairWithSource: true } : {}),
    ...(raw?.adversarial === true ? { adversarial: true } : {}),
    ...(raw?.gate === true ? { gate: true } : {})
  }
}

export function normalizeSessionReviewRepairAssignment(
  value: unknown
): SessionReviewRepairAssignment | undefined {
  const raw = record(value)
  const groupId = text(raw?.groupId)
  const afterRound = integer(raw?.afterRound)
  const candidateVersion = text(raw?.candidateVersion)
  const consumptionKey = text(raw?.consumptionKey)
  return groupId && afterRound && candidateVersion && consumptionKey
    ? {
        groupId,
        afterRound,
        candidateVersion,
        consumptionKey,
        ...(raw?.withSource === true ? { withSource: true } : {})
      }
    : undefined
}

function normalizeReceipt(value: unknown): SessionReviewReceipt | null {
  const raw = record(value)
  if (!raw) {
    return null
  }
  const stepId = text(raw.stepId)
  const reviewerId = text(raw.reviewerId)
  const candidateVersion = text(raw.candidateVersion)
  const recordedAt =
    typeof raw.recordedAt === 'number' && Number.isFinite(raw.recordedAt)
      ? raw.recordedAt
      : undefined
  const status = raw.status as SessionReviewReceipt['status']
  const statuses: SessionReviewReceipt['status'][] = [
    'pass',
    'findings',
    'fail',
    'insufficient_evidence',
    'crashed'
  ]
  if (
    !stepId ||
    !reviewerId ||
    !candidateVersion ||
    recordedAt === undefined ||
    !statuses.includes(status)
  ) {
    return null
  }
  const blockingFindings = Array.isArray(raw.blockingFindings)
    ? raw.blockingFindings.flatMap((entry) => (text(entry) ? [text(entry)!] : [])).slice(0, 100)
    : null
  if (!blockingFindings || (status === 'pass' && blockingFindings.length > 0)) {
    return null
  }
  return {
    stepId,
    reviewerId,
    candidateVersion,
    status,
    blockingFindings,
    ...(text(raw.notes) ? { notes: text(raw.notes) } : {}),
    recordedAt
  }
}

function normalizeGroup(value: unknown): SessionReviewGroupState | null {
  const raw = record(value)
  const id = text(raw?.id)
  const maxRounds = integer(raw?.maxRounds)
  const currentRound = integer(raw?.currentRound)
  const statuses: SessionReviewGroupState['status'][] = [
    'reviewing',
    'repairing',
    'passed',
    'blocked',
    'report-complete'
  ]
  if (
    !id ||
    !maxRounds ||
    !currentRound ||
    currentRound > maxRounds ||
    !statuses.includes(raw?.status as SessionReviewGroupState['status']) ||
    !Array.isArray(raw?.rounds) ||
    !Array.isArray(raw?.consumedRepairKeys)
  ) {
    return null
  }
  const rounds: SessionReviewRoundState[] = []
  const seenRounds = new Set<number>()
  for (const value of raw.rounds) {
    const round = record(value)
    const index = integer(round?.index)
    const candidateVersion = text(round?.candidateVersion)
    if (
      !index ||
      index > maxRounds ||
      seenRounds.has(index) ||
      !candidateVersion ||
      !Array.isArray(round?.receipts)
    ) {
      return null
    }
    const receipts = round.receipts.map(normalizeReceipt)
    if (receipts.some((receipt) => !receipt)) {
      return null
    }
    seenRounds.add(index)
    rounds.push({
      index,
      candidateVersion,
      receipts: receipts as SessionReviewReceipt[],
      ...(text(round.revisedVersion) ? { revisedVersion: text(round.revisedVersion) } : {})
    })
  }
  const consumedRepairKeys = raw.consumedRepairKeys.map(text)
  if (consumedRepairKeys.some((key) => !key)) {
    return null
  }
  return {
    id,
    maxRounds,
    currentRound,
    status: raw.status as SessionReviewGroupState['status'],
    rounds,
    consumedRepairKeys: [...new Set(consumedRepairKeys as string[])]
  }
}

export function normalizeSessionReviewLoopState(
  value: unknown
): SessionReviewLoopState | undefined {
  const raw = record(value)
  if (!raw || !Array.isArray(raw.groups)) {
    return undefined
  }
  const groups = raw.groups.map(normalizeGroup)
  if (groups.some((group) => !group)) {
    return undefined
  }
  const ids = groups.map((group) => group!.id)
  return new Set(ids).size === ids.length
    ? { groups: groups as SessionReviewGroupState[] }
    : undefined
}

export function parseSessionReviewerVerdict(output: string): SessionReviewerVerdict | null {
  const verdict = parseSessionVerdict(output)
  // `ambiguous` (a report carrying a second marker) and an unreadable line are the same answer to a
  // review round: no verdict was returned, so the round cannot pass on it.
  return verdict && verdict !== 'ambiguous'
    ? {
        status: verdict.status,
        blockingFindings: verdict.blockingFindings,
        ...(verdict.notes ? { notes: verdict.notes } : {})
      }
    : null
}

export function sessionReviewRoundDecision(args: {
  expectedReviewerIds: readonly string[]
  receipts: readonly SessionReviewReceipt[]
  candidateVersion: string
  round: number
  maxRounds: number
  reviewOnly: boolean
  gate?: boolean
}): 'pass' | 'repair' | 'blocked' | 'report-complete' {
  const receipts = new Map(
    args.receipts
      .filter((receipt) => receipt.candidateVersion === args.candidateVersion)
      .map((receipt) => [receipt.reviewerId, receipt])
  )
  const expected = args.expectedReviewerIds.map((id) => receipts.get(id))
  if (expected.some((receipt) => !receipt || receipt.status === 'crashed')) {
    return 'blocked'
  }
  // A verifier that could not judge is never a repair and never a pass: it blocks until someone
  // supplies the evidence it named (hub `verify/report.py:161-190`).
  if (expected.some((receipt) => receipt?.status === 'insufficient_evidence')) {
    return 'blocked'
  }
  if (expected.every((receipt) => receipt?.status === 'pass')) {
    return 'pass'
  }
  if (args.reviewOnly) {
    return args.gate ? 'blocked' : 'report-complete'
  }
  return args.round < args.maxRounds ? 'repair' : 'blocked'
}

/** Why a judged round cannot continue. Only `findings` is a decision a person may be asked for. */
export type SessionReviewBlockCause = 'no-verdict' | 'insufficient-evidence' | 'findings'

/** Reads the cause off the receipts, so a persisted blocked round classifies the same after a restart. */
export function sessionReviewBlockCause(
  receipts: readonly Pick<SessionReviewReceipt, 'status'>[]
): SessionReviewBlockCause {
  if (!receipts.length || receipts.some((receipt) => receipt.status === 'crashed')) {
    return 'no-verdict'
  }
  return receipts.some((receipt) => receipt.status === 'insufficient_evidence')
    ? 'insufficient-evidence'
    : 'findings'
}

export function nextSessionReviewCandidateVersion(
  currentVersion: string,
  repairStepId: string
): string {
  return `${currentVersion}:revised-by:${repairStepId}`
}
