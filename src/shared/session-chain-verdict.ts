import { asRecord, optionalString } from './session-chain-record-fields'
import {
  readSessionVerdictChecks,
  sessionVerdictChecksConsistent,
  type SessionVerdictCheck
} from './session-chain-verdict-checks'

// The hub round trip lives next door so this file stays the envelope and its one parser; every
// importer still finds it here. The chain-side receipt helpers are in
// `session-chain-verdict-receipts.ts`, which reads this module — re-exporting them here would make
// that a cycle, so they are imported from there directly.
export { hubVerdictToSession, sessionVerdictToHub } from './session-chain-verdict-hub'
export type { SessionVerdictHub } from './session-chain-verdict-hub'
export type { SessionVerdictCheck, SessionVerdictCheckStatus } from './session-chain-verdict-checks'

/**
 * The machine-readable verdict a judging seat ends its report with, and the one reader of it.
 *
 * Why a second marker beside `OMNI_REVIEW_RESULT:`: that one carries no identity, so a report whose
 * final line was COPIED from a candidate it judged reads as the judge's own verdict, and it has no
 * `fail` (a failing verifier had to choose between inventing findings and being read as crashed).
 * The rules here are the hub's, mirrored: unique integer scores with the winner as the unique argmax
 * (`best_of.py:187-247`), identity binding (`canonical_contract.py:2649-2688`), the agree/disagree
 * consistency predicate (`dispatch_graph.py:1224-1263`) and `insufficient_evidence` as a first-class
 * status (`verify/report.py:55-67`).
 */
export const SESSION_VERDICT_MARKER = 'OMNI_VERDICT:'
export const SESSION_REVIEW_RESULT_MARKER = 'OMNI_REVIEW_RESULT:'

/** Bounds verbatim from `console-loop-verdict.ts:9-11`, so a local and a hub verdict cost the same. */
const MAX_ITEMS = 32
const MAX_ITEM_TEXT = 256
const MAX_NOTES_TEXT = 512
/** `best_of.py:187-247`: a rationale per candidate, and 2–8 candidates in practice. */
const MAX_RATIONALE_TEXT = 2_000
const MAX_SCORES = 32
const MAX_SCORE = 100

export type SessionVerdictKind = 'review' | 'judge' | 'verify' | 'critique'
export type SessionVerdictStatus = 'pass' | 'findings' | 'fail' | 'insufficient_evidence'

export const SESSION_VERDICT_KINDS: readonly SessionVerdictKind[] = [
  'review',
  'judge',
  'verify',
  'critique'
]
/**
 * `insufficient_evidence` is never a pass and never a repair: the verifier is saying it could not
 * judge, which blocks until someone supplies the evidence it named.
 */
export const SESSION_VERDICT_STATUSES: readonly SessionVerdictStatus[] = [
  'pass',
  'findings',
  'fail',
  'insufficient_evidence'
]

/** One candidate's score. Integer 0–100, unique across the set: a tie decides nothing. */
export type SessionVerdictScore = { candidateId: string; score: number; rationale?: string }

export type SessionVerdict = {
  kind: SessionVerdictKind
  status: SessionVerdictStatus
  /**
   * The seat, attempt and version this verdict was issued for. Required in an `OMNI_VERDICT:`
   * envelope and absent from a legacy `OMNI_REVIEW_RESULT:` line, which predates identity binding;
   * the consumer refuses a bound step whose verdict names a different attempt.
   */
  stepId?: string
  attemptId?: string
  candidateVersion?: string
  /** Derived from `scores`, never taken from the author: a ranking may not contradict the scores. */
  ranking?: string[]
  winnerId?: string
  scores?: SessionVerdictScore[]
  blockingFindings: string[]
  /** A verify gate's per-line results; `pass` requires every one of them to pass. */
  checks?: SessionVerdictCheck[]
  notes?: string
  confidence?: number
  /** Which marker carried it; only `verdict` can be bound to an attempt. */
  marker: 'verdict' | 'review-result'
}

function isKind(value: unknown): value is SessionVerdictKind {
  return SESSION_VERDICT_KINDS.includes(value as SessionVerdictKind)
}

function isStatus(value: unknown): value is SessionVerdictStatus {
  return SESSION_VERDICT_STATUSES.includes(value as SessionVerdictStatus)
}

/** Order-preserving dedupe inside the hub's limits; anything outside them refuses the verdict. */
function items(value: unknown): string[] | null {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    return null
  }
  const texts: string[] = []
  for (const entry of value) {
    const text = optionalString(entry)
    if (!text || text.length > MAX_ITEM_TEXT || text.includes('\0')) {
      return null
    }
    texts.push(text)
  }
  return [...new Set(texts)]
}

/** A list of ids with no duplicates: `undefined` means absent, `null` means refused. */
function ids(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCORES) {
    return null
  }
  const list: string[] = []
  for (const entry of value) {
    const text = optionalString(entry)
    if (!text || text.length > MAX_ITEM_TEXT || list.includes(text)) {
      return null
    }
    list.push(text)
  }
  return list
}

function readScores(value: unknown): SessionVerdictScore[] | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCORES) {
    return null
  }
  const scores: SessionVerdictScore[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const candidateId = record ? optionalString(record.candidateId) : undefined
    const score = record?.score
    const rationale = record ? optionalString(record.rationale) : undefined
    if (
      !candidateId ||
      candidateId.length > MAX_ITEM_TEXT ||
      // Why the explicit number test: `true` is not an integer, and neither is "80".
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > MAX_SCORE ||
      (rationale && rationale.length > MAX_RATIONALE_TEXT)
    ) {
      return null
    }
    scores.push({ candidateId, score, ...(rationale ? { rationale } : {}) })
  }
  return scores
}

/** pass ⇒ nothing blocks; findings and fail ⇒ at least one thing does. Silence never means agree. */
function consistent(status: SessionVerdictStatus, blockingFindings: string[]): boolean {
  if (status === 'pass') {
    return blockingFindings.length === 0
  }
  return status === 'insufficient_evidence' || blockingFindings.length > 0
}

/** Every candidate scored once, scores unique, winner inside the set and the unique argmax. */
function selection(
  scores: SessionVerdictScore[],
  winnerId: string | undefined,
  authored: string[] | undefined
): { winnerId: string; ranking: string[] } | null {
  const candidates = scores.map((entry) => entry.candidateId)
  const values = scores.map((entry) => entry.score)
  if (
    !winnerId ||
    new Set(candidates).size !== candidates.length ||
    new Set(values).size !== values.length ||
    !candidates.includes(winnerId)
  ) {
    return null
  }
  const ranking = [...scores]
    .sort((left, right) => right.score - left.score)
    .map((e) => e.candidateId)
  if (ranking[0] !== winnerId) {
    return null
  }
  // The judge does not author the order: a ranking that contradicts its own scores is refused.
  return authored &&
    (authored.length !== ranking.length || authored.some((id, at) => id !== ranking[at]))
    ? null
    : { winnerId, ranking }
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1
}

function readPayload(json: string, bound: boolean): SessionVerdict | null {
  let raw: Record<string, unknown> | null = null
  try {
    raw = asRecord(JSON.parse(json))
  } catch {
    return null
  }
  const status = raw?.status
  const kind = raw?.kind ?? (bound ? undefined : 'review')
  const blockingFindings = raw ? items(raw.blockingFindings) : null
  const notes = raw ? optionalString(raw.notes) : undefined
  const confidence = raw?.confidence
  if (
    !raw ||
    !isStatus(status) ||
    !isKind(kind) ||
    !blockingFindings ||
    !consistent(status, blockingFindings) ||
    (notes !== undefined && notes.length > MAX_NOTES_TEXT) ||
    (confidence !== undefined &&
      (typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1))
  ) {
    return null
  }
  const identity = {
    stepId: optionalString(raw.stepId),
    attemptId: optionalString(raw.attemptId),
    candidateVersion: optionalString(raw.candidateVersion)
  }
  // The envelope binds itself to one attempt; a candidate cannot know the judge's attempt id.
  if (bound && Object.values(identity).some((value) => !value || value.length > MAX_ITEM_TEXT)) {
    return null
  }
  const scores = readScores(raw.scores)
  const authored = ids(raw.ranking)
  const winner = optionalString(raw.winnerId)
  const checks = readSessionVerdictChecks(raw.checks)
  if (
    scores === null ||
    authored === null ||
    checks === null ||
    (checks && !sessionVerdictChecksConsistent(status, checks))
  ) {
    return null
  }
  const selected = scores ? selection(scores, winner, authored) : null
  if (scores && !selected) {
    return null
  }
  return {
    kind,
    status,
    ...(identity.stepId ? { stepId: identity.stepId } : {}),
    ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
    ...(identity.candidateVersion ? { candidateVersion: identity.candidateVersion } : {}),
    ...(selected ? { ranking: selected.ranking } : authored ? { ranking: authored } : {}),
    ...(winner ? { winnerId: winner } : {}),
    ...(scores ? { scores } : {}),
    blockingFindings,
    ...(checks ? { checks } : {}),
    ...(notes ? { notes } : {}),
    ...(typeof confidence === 'number' ? { confidence } : {}),
    marker: bound ? 'verdict' : 'review-result'
  }
}

/**
 * The one reader of a report's verdict. `null` is "no readable verdict", `'ambiguous'` is a report
 * carrying more than one marker — the forgery shape, where a judge's report ends in a line it quoted
 * from a candidate. Both are refusals: neither may ever be consumed as a pass.
 */
export function parseSessionVerdict(text: string): SessionVerdict | null | 'ambiguous' {
  const bound = occurrences(text, SESSION_VERDICT_MARKER)
  const legacy = occurrences(text, SESSION_REVIEW_RESULT_MARKER)
  if (bound + legacy === 0) {
    return null
  }
  if (bound + legacy > 1) {
    return 'ambiguous'
  }
  const marker = bound ? SESSION_VERDICT_MARKER : SESSION_REVIEW_RESULT_MARKER
  const final = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0)
  // The marker must be the report's FINAL non-empty line: prose after a verdict revises it in words
  // the host cannot read.
  return final?.startsWith(marker) ? readPayload(final.slice(marker.length), bound > 0) : null
}
