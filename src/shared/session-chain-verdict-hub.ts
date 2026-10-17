import type {
  SessionVerdict,
  SessionVerdictKind,
  SessionVerdictStatus
} from './session-chain-verdict'
import {
  readSessionVerdictChecks,
  sessionVerdictChecksConsistent,
  type SessionVerdictCheck
} from './session-chain-verdict-checks'

/**
 * The hub's loop verdict, structurally identical to `ConsoleWorkflowLoopVerdict`
 * (`src/main/console-workflows/console-local-execution-contract.ts:13-18`) — declared here rather
 * than imported because shared may not import main. One schema, two placements: a review round the
 * person runs locally and one the hub runs on a card produce the same record.
 */
export type SessionVerdictHub = {
  verdict: 'agree' | 'disagree'
  blockers: string[]
  gaps: string[]
  notes: string
  /** A verify gate's per-line results; optional, so a record without them stays a valid hub record. */
  checks?: SessionVerdictCheck[]
}

/**
 * The hub's decision is two-valued and a session verdict is four-valued, so one bit has nowhere to
 * sit: `findings` and `fail` are both "disagree with blockers". That bit rides in a typed note
 * prefix, which keeps the record a valid `verdict.json` for every hub reader and keeps the round
 * trip lossless. `insufficient_evidence` needs no tag: it is the only disagreement with no blocker.
 */
const FAIL_TAG = 'omni-status:fail'
/** A verifier that could not judge still has to carry one gap, because "disagree" demands one. */
const NO_JUDGEMENT = 'The verifier could not judge this candidate on the evidence it was given.'

export function sessionVerdictToHub(verdict: SessionVerdict): SessionVerdictHub {
  const notes = verdict.notes ?? ''
  const lines = verdict.checks ? { checks: verdict.checks.map((check) => ({ ...check })) } : {}
  if (verdict.status === 'pass') {
    return { verdict: 'agree', blockers: [], gaps: [], notes, ...lines }
  }
  if (verdict.status === 'insufficient_evidence') {
    return {
      verdict: 'disagree',
      blockers: [],
      gaps: verdict.blockingFindings.length ? [...verdict.blockingFindings] : [NO_JUDGEMENT],
      notes,
      ...lines
    }
  }
  return {
    verdict: 'disagree',
    blockers: [...verdict.blockingFindings],
    gaps: [],
    notes: verdict.status === 'fail' ? [FAIL_TAG, notes].filter(Boolean).join(' ') : notes,
    ...lines
  }
}

function statusOf(hub: SessionVerdictHub): SessionVerdictStatus | null {
  if (hub.verdict === 'agree') {
    // The hub's own rule: agreement that carries blockers or gaps is not agreement.
    return hub.blockers.length || hub.gaps.length ? null : 'pass'
  }
  if (hub.blockers.length) {
    return hub.notes.startsWith(FAIL_TAG) ? 'fail' : 'findings'
  }
  return hub.gaps.length ? 'insufficient_evidence' : null
}

/**
 * The inverse. `identity` carries what the loop record has no field for — which seat issued it,
 * what it judged and a verify gate's per-line `checks` — so a receipt read back from the hub names
 * the same attempt and lines as a local one. Returns null for a record the hub itself would refuse
 * (a disagreement with nothing named), or for checks that contradict its status.
 */
export function hubVerdictToSession(
  hub: SessionVerdictHub,
  identity: {
    kind?: SessionVerdictKind
    stepId?: string
    attemptId?: string
    candidateVersion?: string
    checks?: SessionVerdictCheck[]
  } = {}
): SessionVerdict | null {
  const status = statusOf(hub)
  // The record's own lines win; a caller that kept them elsewhere may still hand them back.
  const stored = hub.checks === undefined ? undefined : readSessionVerdictChecks(hub.checks)
  const checks = stored ?? identity.checks
  if (!status || stored === null || (checks && !sessionVerdictChecksConsistent(status, checks))) {
    return null
  }
  const notes = (status === 'fail' ? hub.notes.slice(FAIL_TAG.length) : hub.notes).trim()
  const named = status === 'insufficient_evidence' ? hub.gaps : hub.blockers
  return {
    kind: identity.kind ?? 'review',
    status,
    ...(identity.stepId ? { stepId: identity.stepId } : {}),
    ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
    ...(identity.candidateVersion ? { candidateVersion: identity.candidateVersion } : {}),
    blockingFindings: named.length === 1 && named[0] === NO_JUDGEMENT ? [] : [...named],
    ...(checks ? { checks: [...checks] } : {}),
    ...(notes ? { notes } : {}),
    marker: 'verdict'
  }
}
