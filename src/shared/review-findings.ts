/**
 * A reviewer's findings as data. The reviewer writes one `OMNI_FINDINGS:` line; the host checks
 * each blocker's evidence against the candidate; unresolved blockers also withhold approval.
 */
export const REVIEW_FINDINGS_MARKER = 'OMNI_FINDINGS:'
export const REVIEW_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number]

const MAX_FINDINGS = 32
const MAX_TEXT = 2_000
const MAX_ARGS = 32

/**
 * An existing test in the workspace (not run yet), a command the reviewer ran (never run by the
 * host), or text quoted from the candidate verbatim.
 */
export type ReviewEvidence =
  | { kind: 'test'; file: string; name?: string }
  | {
      kind: 'command'
      program: string
      args: string[]
      expect: 'fail' | 'output'
      output?: string
      /** The reviewer gave an expected output the parser could not use; the claim cannot be checked. */
      outputInvalid?: true
    }
  | { kind: 'quote'; text: string; file?: string }

export type ReviewFinding = {
  id: string
  severity: ReviewFindingSeverity
  claim: string
  location?: string
  evidence?: ReviewEvidence
  fix?: string
}

/**
 * What the host found when it checked a finding's evidence on the candidate:
 * - `confirmed`: reserved for a named test the host runs itself, which is not enabled yet;
 * - `located`: the quote is in the candidate, a named test, or the reviewer's own command (never
 *   run); all still block;
 * - `not-reproduced`: no fresh check produces it; saved by earlier versions, and it still blocks;
 * - `unverified`: the host could not verify it (a quote not found in the file, a remote workspace,
 *   an unreadable or oversized file, a command that could prove itself or unusable expected output);
 * - `needs-evidence`: the finding carries no evidence the host can check.
 */
export type ReviewEvidenceStatus =
  | 'confirmed'
  | 'located'
  | 'not-reproduced'
  | 'unverified'
  | 'needs-evidence'

export type CheckedReviewFinding = ReviewFinding & {
  status: ReviewEvidenceStatus
  /** What the check saw, or why it could not check. */
  detail?: string
  /** The host check that produced `status`; absent on findings saved before this one. */
  checkVersion?: number
}

export const REVIEW_CHECK_VERSION = 5

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
}

function evidence(value: unknown): ReviewEvidence | undefined | null {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (raw.kind === 'test') {
    const file = text(raw.file, 512)
    const name = raw.name === undefined ? undefined : text(raw.name, 256)
    return file && (raw.name === undefined || name)
      ? { kind: 'test', file, ...(name ? { name } : {}) }
      : null
  }
  if (raw.kind === 'quote') {
    const quote = text(raw.text)
    const file = raw.file === undefined ? undefined : text(raw.file, 512)
    return quote && (raw.file === undefined || file)
      ? { kind: 'quote', text: quote, ...(file ? { file } : {}) }
      : null
  }
  if (raw.kind === 'command') {
    const program = text(raw.program, 256)
    const args = Array.isArray(raw.args) ? raw.args : []
    const expect = raw.expect === 'output' ? 'output' : raw.expect === 'fail' ? 'fail' : null
    const output = text(raw.output)
    // Supplied but unusable output must never read as "no expectation".
    const outputInvalid = raw.output !== undefined && raw.output !== null && !output
    if (
      !program ||
      !expect ||
      args.length > MAX_ARGS ||
      !args.every((arg) => typeof arg === 'string' && arg.length <= MAX_TEXT) ||
      (expect === 'output' && !output && !outputInvalid)
    ) {
      return null
    }
    return {
      kind: 'command',
      program,
      args: args as string[],
      expect,
      ...(output ? { output } : {}),
      ...(outputInvalid ? { outputInvalid: true as const } : {})
    }
  }
  return null
}

function finding(value: unknown, index: number): ReviewFinding | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  const severity = REVIEW_FINDING_SEVERITIES.find((entry) => entry === raw.severity)
  const claim = text(raw.claim)
  const checked = evidence(raw.evidence)
  if (!severity || !claim || checked === null) {
    return null
  }
  const location = text(raw.location, 512)
  const fix = text(raw.fix)
  return {
    id: text(raw.id, 64) ?? `F${index + 1}`,
    severity,
    claim,
    ...(location ? { location } : {}),
    ...(checked ? { evidence: checked } : {}),
    ...(fix ? { fix } : {})
  }
}

/**
 * The findings on the report's one `OMNI_FINDINGS:` line. Null when there is no such line, more
 * than one, or the JSON is not the contract: the caller then falls back to the verdict alone,
 * so a malformed line can never turn a rejection into an approval.
 */
export function parseReviewFindings(body: string | null | undefined): ReviewFinding[] | null {
  const lines = (body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^`+|`+$/g, ''))
    .filter((line) => line.startsWith(REVIEW_FINDINGS_MARKER))
  if (lines.length !== 1) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(lines[0]!.slice(REVIEW_FINDINGS_MARKER.length))
  } catch {
    return null
  }
  const list = raw && typeof raw === 'object' ? (raw as { findings?: unknown }).findings : null
  if (!Array.isArray(list) || list.length > MAX_FINDINGS) {
    return null
  }
  const findings = list.map(finding)
  if (findings.some((entry) => entry === null)) {
    return null
  }
  const ids = new Set(findings.map((entry) => entry!.id))
  return ids.size === findings.length ? (findings as ReviewFinding[]) : null
}

/**
 * Findings saved by an earlier host check, migrated fail-closed: their records cannot show whether
 * a quote's file was read in full or a run completed, and a reviewer's command no longer confirms
 * or clears, so `confirmed` becomes `located` and `not-reproduced` becomes `unverified`.
 */
export function normalizeLegacyCheckedFindings(
  findings: CheckedReviewFinding[] | null | undefined
): void {
  for (const entry of Array.isArray(findings) ? findings : []) {
    if (!entry?.evidence || (entry.checkVersion ?? 0) >= 5) {
      continue
    }
    // Before version 5 an absent quote, a reviewer's command or a named test could clear a blocker.
    if (entry.status === 'confirmed') {
      entry.status = 'located'
    } else if (entry.status === 'not-reproduced') {
      entry.status = 'unverified'
    }
  }
}

/** Every blocker that carries evidence withholds approval; a saved `not-reproduced` fails safe too. */
export function reviewFindingBlocks(entry: CheckedReviewFinding): boolean {
  return entry.severity === 'blocker' && entry.status !== 'needs-evidence'
}

const STATUS_TEXT: Record<ReviewEvidenceStatus, string> = {
  confirmed: 'reproduced in an earlier version',
  located: 'located but not proven',
  'not-reproduced': 'not reproduced (earlier version)',
  unverified: 'not verified',
  'needs-evidence': 'no checkable evidence'
}

/** One finding as the builder and the next round read it. */
export function describeCheckedFinding(entry: CheckedReviewFinding): string {
  return [
    `- [${entry.severity.toUpperCase()} ${entry.id}] ${entry.claim}`,
    entry.location ? ` (${entry.location})` : '',
    ` — evidence ${Object.hasOwn(STATUS_TEXT, entry.status) ? STATUS_TEXT[entry.status] : STATUS_TEXT.unverified}`,
    reviewFindingBlocks(entry)
      ? '; still blocking'
      : entry.severity === 'blocker'
        ? '; does not block'
        : '; a suggestion, never blocks',
    entry.detail ? `: ${entry.detail}` : '',
    entry.fix ? `\n  Suggested fix: ${entry.fix}` : ''
  ].join('')
}
