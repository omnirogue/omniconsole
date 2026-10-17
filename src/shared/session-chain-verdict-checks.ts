import { asRecord, optionalString } from './session-chain-record-fields'

/**
 * One Done When line, decided by the verify seat on evidence it produced itself.
 *
 * Why per line: a single `status` let a verifier that read the worker's report and agreed with it
 * receipt every line at once. Each line now carries its own result and the evidence behind it, and a
 * line is receipted only when its own check passed.
 */
export type SessionVerdictCheckStatus = 'pass' | 'fail' | 'unknown'
export type SessionVerdictCheck = {
  id: string
  status: SessionVerdictCheckStatus
  evidence: string
}

const CHECK_STATUSES: readonly SessionVerdictCheckStatus[] = ['pass', 'fail', 'unknown']
const MAX_CHECKS = 32
const MAX_ID_TEXT = 256
const MAX_EVIDENCE_TEXT = 1_000

/** `undefined` means absent, `null` means refused: a malformed list never counts as checked. */
export function readSessionVerdictChecks(value: unknown): SessionVerdictCheck[] | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS) {
    return null
  }
  const checks: SessionVerdictCheck[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    const id = record ? optionalString(record.id) : undefined
    const status = record?.status
    const evidence = record ? optionalString(record.evidence) : undefined
    if (
      !id ||
      id.length > MAX_ID_TEXT ||
      checks.some((check) => check.id === id) ||
      !CHECK_STATUSES.includes(status as SessionVerdictCheckStatus) ||
      !evidence ||
      evidence.length > MAX_EVIDENCE_TEXT ||
      evidence.includes('\0')
    ) {
      return null
    }
    checks.push({ id, status: status as SessionVerdictCheckStatus, evidence })
  }
  return checks
}

/** A verdict passes only when every line it checked passed; one failed or unknown line blocks. */
export function sessionVerdictChecksConsistent(
  status: string,
  checks: readonly SessionVerdictCheck[]
): boolean {
  const allPass = checks.every((check) => check.status === 'pass')
  return status === 'pass' ? allPass : true
}

/**
 * The Done When lines a verify gate was asked to decide but did not check, or checked under an id it
 * was not given. Either one means the per-line verdict is incomplete and nothing may be receipted.
 */
export function sessionVerdictCheckGaps(
  over: readonly string[],
  checks: readonly SessionVerdictCheck[] | undefined
): { missing: string[]; unknown: string[] } {
  const checked = new Set((checks ?? []).map((check) => check.id))
  return {
    missing: over.filter((id) => !checked.has(id)),
    unknown: [...checked].filter((id) => !over.includes(id))
  }
}

/** The ids whose own check passed: the only lines a gate may receipt. */
export function sessionVerdictPassedIds(
  checks: readonly SessionVerdictCheck[] | undefined
): Set<string> {
  return new Set((checks ?? []).filter((check) => check.status === 'pass').map((check) => check.id))
}

/**
 * A verify gate deciding Done When lines: the one seat whose work may be satisfied away from disk
 * (a reply sent, an ad changed), so the only one a plain folder with no named files may pin.
 */
export function isVerifyGateStep(step: {
  verdict?: { kind: string; consumed: string }
  review?: unknown
}): boolean {
  return step.verdict?.kind === 'verify' && step.verdict.consumed === 'gate' && !step.review
}
