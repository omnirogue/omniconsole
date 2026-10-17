import { workflowInertMarkdown, type WorkflowWebCheck } from './workflow-graph-web'
import { workflowLastFencedBlock } from './workflow-report-ranking'

/** The app only ever moves a claim towards open, so what nobody could check never reads as settled. */
type WorkflowClaimStatus = 'confirmed' | 'refuted' | 'open'

export type WorkflowClaimRow = {
  claim: string
  status: WorkflowClaimStatus
  evidence: string
  /** The fact-check key the row stands on, when it names one. */
  key?: string
  /** Why the app moved the row to open. */
  note?: string
  /** A run that reads pages: the app's own check of each web quote the row or its claim cites. */
  webChecks?: WorkflowWebCheck[]
  /** It cites or rests on a web page, so only the app's own found quote may confirm it. */
  reliesOnWeb?: true
}

/** One fact-checked claim as the app recorded it. */
export type WorkflowClaimCheck = {
  key: string
  title: string
  location: string
  tally: 'confirmed' | 'refuted' | 'unverified'
  unchecked?: boolean
  /** The app's quote check in plain words, when it made one. */
  quote?: string
}

export const WORKFLOW_CLAIM_TABLE_INSTRUCTION = [
  'After the answer, append exactly one fenced block tagged `claims` (the app reads it, checks each row against the fact-check and shows it as the table of key claims):',
  '```claims',
  '[{"claim": "<the claim in one sentence>", "status": "confirmed", "evidence": "<path:line or source, and what it shows>", "key": "<the fact-check key it stands on, e.g. investigate.r1.3, or empty>"}]',
  '```',
  'List the key claims, most important first. status is "confirmed", "refuted" or "open". A confirmed row names its evidence and the key of a claim the fact-check confirmed; a refuted row names the evidence against it; whatever could not be checked is open. Nothing may follow the block.'
].join('\n')

const MAX_ROWS = 30
const CLAIM_CHARS = 300
const EVIDENCE_CHARS = 400
/** Evidence that says it was not checked is no evidence at all. */
const NO_EVIDENCE =
  /^(?:none|n\/?a|unknown|-+|—)$|\b(?:could ?n[o']t|cannot|can't|unable to|not) (?:be )?(?:check|verif|read|open|found)|\b(?:unchecked|unverified|unreadable)\b/i

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit).trimEnd()} …` : text

function readRow(entry: unknown): WorkflowClaimRow | undefined {
  const row = (entry ?? {}) as Record<string, unknown>
  const claim = typeof row.claim === 'string' ? row.claim.replace(/\s+/g, ' ').trim() : ''
  if (!claim) {
    return undefined
  }
  const status = String(row.status ?? '')
    .trim()
    .toLowerCase()
  const key = typeof row.key === 'string' ? row.key.trim() : ''
  return {
    claim: clip(claim, CLAIM_CHARS),
    status: status === 'confirmed' || status === 'refuted' ? status : 'open',
    evidence:
      typeof row.evidence === 'string'
        ? clip(row.evidence.replace(/\s+/g, ' ').trim(), EVIDENCE_CHARS)
        : '',
    ...(key ? { key } : {})
  }
}

/** The answer people read without its last `claims` block, and the rows when the block parses. */
export function splitWorkflowClaimTable(markdown: string): {
  markdown: string
  rows?: WorkflowClaimRow[]
} {
  const block = workflowLastFencedBlock(markdown, 'claims')
  if (!block) {
    return { markdown }
  }
  const body = [markdown.slice(0, block.start).trim(), markdown.slice(block.end).trim()]
    .filter(Boolean)
    .join('\n\n')
  let raw: unknown
  try {
    raw = JSON.parse(block.body)
  } catch {
    return { markdown: body }
  }
  if (!Array.isArray(raw)) {
    return { markdown: body }
  }
  const rows = raw.flatMap((entry) => readRow(entry) ?? []).slice(0, MAX_ROWS)
  return rows.length ? { markdown: body, rows } : { markdown: body }
}

const hasEvidence = (text: string) => !!text.trim() && !NO_EVIDENCE.test(text.trim())

function why(row: WorkflowClaimRow, check: WorkflowClaimCheck | undefined): string | undefined {
  if (row.status === 'open') {
    return undefined
  }
  const unbacked = (row.webChecks ?? []).filter((entry) => entry.mark !== 'found')
  if (row.status === 'confirmed' && unbacked.length) {
    return `the app did not find a web quote it cites in its page (${[...new Set(unbacked.map((entry) => entry.id))].join(', ')})`
  }
  // Nothing recognised is nothing checked: a claim resting on a page stays open without a check.
  if (row.status === 'confirmed' && row.reliesOnWeb && !row.webChecks?.length) {
    return 'it rests on a web page, and the app found no quote of it to check'
  }
  if (!hasEvidence(row.evidence)) {
    return 'it names no evidence'
  }
  if (row.status === 'refuted') {
    return check?.tally === 'confirmed' && !check.unchecked
      ? 'the fact-check confirmed it'
      : undefined
  }
  if (!check) {
    return row.key ? 'its key matches no fact-checked claim' : 'it was not fact-checked'
  }
  if (check.unchecked) {
    return 'the fact-check did not reach it'
  }
  return check.tally === 'confirmed' ? undefined : 'the fact-check did not confirm it'
}

/** Each row held to the fact-check: a confirmation the check does not back becomes open. */
export function settleWorkflowClaims(
  rows: readonly WorkflowClaimRow[],
  checks: readonly WorkflowClaimCheck[]
): WorkflowClaimRow[] {
  const byKey = new Map(checks.map((check) => [check.key, check]))
  return rows.map((row) => {
    const reason = why(row, row.key ? byKey.get(row.key) : undefined)
    return reason ? { ...row, status: 'open', note: `was marked ${row.status}; ${reason}` } : row
  })
}

/** Without the writer's rows, the table is the fact-check itself, the checked claims first. */
export function workflowClaimsFromChecks(
  checks: readonly WorkflowClaimCheck[]
): WorkflowClaimRow[] {
  const rows = checks.map((check): WorkflowClaimRow => {
    const evidence = [check.location, check.quote].filter(Boolean).join(' · ')
    const status = check.unchecked
      ? 'open'
      : check.tally === 'refuted'
        ? 'refuted'
        : check.tally === 'confirmed' && check.location.trim()
          ? 'confirmed'
          : 'open'
    return {
      claim: clip(check.title, CLAIM_CHARS),
      status,
      evidence: clip(evidence, EVIDENCE_CHARS),
      key: check.key,
      ...(check.tally === 'confirmed' && status === 'open'
        ? { note: 'confirmed, but it names no evidence' }
        : {})
    }
  })
  const order = { confirmed: 0, refuted: 1, open: 2 }
  // Why copy-then-sort: mobile's Hermes has no Array.prototype.toSorted.
  return [...rows]
    .sort((left, right) => order[left.status] - order[right.status])
    .slice(0, MAX_ROWS)
}

const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() || '—'
// The table of a run that reads pages is the app's part, so no model word in it may open anything.
const inertCell = (text: string) => workflowInertMarkdown(text) || '—'
const LABELS: Record<WorkflowClaimStatus, string> = {
  confirmed: 'Confirmed',
  refuted: 'Refuted',
  open: 'Open'
}

const APP_MARKS: Record<WorkflowWebCheck['mark'], string> = {
  found: 'found in the page',
  'not-in-page': 'NOT in the page',
  'leaves-out': 'leaves words out, not checked',
  unreadable: 'page could not be read',
  unknown: 'no such source',
  unquoted: 'no quote given',
  pending: 'page not read yet'
}

// The evidence is what the model wrote; the app's own check of its quotes sits in a column apart.
const appCheck = (row: WorkflowClaimRow) =>
  row.webChecks?.length
    ? [...new Set(row.webChecks.map((entry) => `${entry.id} ${APP_MARKS[entry.mark]}`))].join('; ')
    : 'no web quote'

/** The table as markdown, so every copy of the answer carries it. */
export function renderWorkflowClaimTable(rows: readonly WorkflowClaimRow[]): string {
  if (rows.some((row) => row.webChecks)) {
    return [
      '## Confirmed, refuted and open',
      '',
      '| Claim | Status | Evidence, as the model wrote it | App quote check |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (row) =>
          `| ${inertCell(row.claim)} | ${LABELS[row.status]}${row.note ? ` (${inertCell(row.note)})` : ''} | ${inertCell(row.evidence)} | ${appCheck(row)} |`
      )
    ].join('\n')
  }
  return [
    '## Confirmed, refuted and open',
    '',
    '| Claim | Status | Evidence |',
    '| --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${cell(row.claim)} | ${LABELS[row.status]}${row.note ? ` (${cell(row.note)})` : ''} | ${cell(row.evidence)} |`
    )
  ].join('\n')
}
