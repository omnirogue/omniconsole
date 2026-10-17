import {
  JEV_OUTCOME_SCHEMA,
  jevOutcomeParamsSchema,
  jevRecordsExportSchema,
  jevRecordsListSchema,
  type JevCallRow,
  type JevOutcomeRow,
  type JevRecordsExportParams,
  type JevRecordsListParams
} from '../../shared/jev-ledger'
import { JEV_CALLS_FILE, JEV_OUTCOMES_FILE, type JevLedger } from './jev-ledger'
import {
  completeLines,
  isLedgerSegment,
  ledgerHasRecord,
  parseLedgerLine,
  readCallRows,
  readOutcomeRows,
  readSegment,
  rotatedCallSegments,
  segmentClosedAt,
  segmentHead
} from './jev-ledger-reader'

const EXPORT_PAGE_BYTES = 768 * 1024
const FUTURE_SKEW_MS = 5 * 60_000
type Cursor = { segment: string; offset: number; head: string | null }

const at = (value: string): number => Date.parse(value)

/** Newest first, with how many independent outcome rows each record already has. */
export async function listJevRecords(ledger: JevLedger, params: JevRecordsListParams) {
  const parsed = jevRecordsListSchema.parse(params)
  // Why exclusive: a rotation between listing and reading the files would hide a whole file.
  return ledger.exclusive(() => listRecords(ledger, parsed))
}

async function listRecords(
  ledger: JevLedger,
  { since, caller, limit }: { since?: string; caller?: string; limit: number }
) {
  const sinceMs = since ? at(since) : null
  const segments = [JEV_CALLS_FILE, ...(await rotatedCallSegments(ledger.directory)).toReversed()]
  const found: JevCallRow[] = []
  let malformed = 0
  let unread = 0
  for (const [index, name] of segments.entries()) {
    const closed = segmentClosedAt(name)
    if (found.length > limit || (sinceMs !== null && closed !== null && closed < sinceMs)) {
      unread = segments.length - index
      break
    }
    const read = await readCallRows(ledger.directory, name)
    malformed += read.malformed
    for (const row of read.rows) {
      if (
        (sinceMs === null || at(row.observed_at) >= sinceMs) &&
        (caller === undefined || row.caller === caller)
      ) {
        found.push(row)
      }
    }
  }
  const outcomes = new Map<string, number>()
  for (const row of await readOutcomeRows(ledger.directory)) {
    outcomes.set(row.record_key, (outcomes.get(row.record_key) ?? 0) + 1)
  }
  const records = found
    .toSorted((a, b) => at(b.observed_at) - at(a.observed_at))
    .slice(0, limit)
    .map((row) => ({
      record_key: row.record_key,
      observed_at: row.observed_at,
      caller: row.caller,
      transport: row.transport,
      deadline_ms: row.deadline_ms,
      model: row.model,
      ref: row.ref,
      status: row.status,
      provider_status: row.provider_status,
      kind: row.kind,
      reason: row.reason,
      question_ids: row.question_ids,
      elapsed_ms: row.elapsed_ms,
      calls: row.calls,
      outcomes: outcomes.get(row.record_key) ?? 0
    }))
  return {
    records,
    truncated: found.length > limit || (unread > 0 && sinceMs === null),
    ledger: {
      directory: ledger.directory,
      write_failures: ledger.writeFailures,
      malformed_lines: malformed
    }
  }
}

function decodeCursor(value: string): Cursor {
  const cursor = parseLedgerLine<Cursor>(Buffer.from(value, 'base64url').toString('utf8'))
  if (
    !cursor ||
    typeof cursor.segment !== 'string' ||
    !isLedgerSegment(cursor.segment) ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    (cursor.head !== null && typeof cursor.head !== 'string')
  ) {
    throw new Error('Invalid JEV records export cursor.')
  }
  return cursor
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url')

/** Resolves a cursor whose live calls file was rotated (renamed) since the last page. */
async function resume(directory: string, cursor: Cursor, rotated: string[]): Promise<Cursor> {
  if (cursor.segment !== JEV_CALLS_FILE || cursor.head === null) {
    return cursor
  }
  if ((await segmentHead(directory, JEV_CALLS_FILE)) === cursor.head) {
    return cursor
  }
  for (const name of rotated.toReversed()) {
    if ((await segmentHead(directory, name)) === cursor.head) {
      return { ...cursor, segment: name }
    }
  }
  throw new Error('The JEV ledger changed during export; export again with --since.')
}

/** Every `jev-call/1` then `jev-outcome/1` row in file order, one bounded page per call. */
export async function exportJevRecords(
  ledger: JevLedger,
  params: JevRecordsExportParams,
  pageBytes = EXPORT_PAGE_BYTES
) {
  const parsed = jevRecordsExportSchema.parse(params)
  return ledger.exclusive(() => exportPage(ledger, parsed, pageBytes))
}

async function exportPage(
  ledger: JevLedger,
  { since, cursor: token }: { since?: string; cursor?: string },
  pageBytes: number
): Promise<{ rows: unknown[]; cursor: string | null }> {
  const sinceMs = since ? at(since) : null
  const rotated = await rotatedCallSegments(ledger.directory)
  const order = [...rotated, JEV_CALLS_FILE, JEV_OUTCOMES_FILE]
  let cursor: Cursor | null = token
    ? await resume(ledger.directory, decodeCursor(token), rotated)
    : {
        segment:
          rotated.find((name) => sinceMs === null || (segmentClosedAt(name) ?? 0) >= sinceMs) ??
          JEV_CALLS_FILE,
        offset: 0,
        head: null
      }
  const rows: unknown[] = []
  let used = 0
  while (cursor) {
    const { segment } = cursor
    const head =
      segment === JEV_CALLS_FILE ? await segmentHead(ledger.directory, segment) : cursor.head
    let offset = cursor.offset
    for (const { line, bytes } of completeLines(
      await readSegment(ledger.directory, segment, offset)
    )) {
      if (rows.length > 0 && used + bytes > pageBytes) {
        return { rows, cursor: encodeCursor({ segment, offset, head }) }
      }
      offset += bytes
      const row = parseLedgerLine<{ observed_at?: unknown }>(line)
      // Why: --since narrows call rows only. An outcome's recorded_at is the labeler's own time
      // and can predate the last pull, so outcomes.jsonl is always exported in full.
      const time = row?.observed_at
      if (
        row &&
        (sinceMs === null ||
          segment === JEV_OUTCOMES_FILE ||
          (typeof time === 'string' && at(time) >= sinceMs))
      ) {
        rows.push(row)
        used += bytes
      }
    }
    // Why name order: rotated names sort by time and before calls.jsonl, then outcomes.jsonl.
    const next = order.find((name) => name > segment)
    cursor = next ? { segment: next, offset: 0, head: null } : null
  }
  return { rows, cursor: null }
}

/** Appends one independent label after the record exists and the label is not a duplicate. */
export async function appendJevOutcome(
  ledger: JevLedger,
  params: unknown,
  stored: (recordKey: string) => Promise<boolean>,
  now = new Date()
): Promise<{ outcome: JevOutcomeRow; storage: { status: 'saved'; file: string } }> {
  const { record_key, outcome } = jevOutcomeParamsSchema.parse(params)
  const recordedAt = new Date(outcome.recorded_at ?? now.toISOString())
  if (recordedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    throw new Error('recorded_at is in the future.')
  }
  const row: JevOutcomeRow = {
    schema: JEV_OUTCOME_SCHEMA,
    record_key,
    question_id: outcome.question_id,
    label: outcome.label,
    evidence_level: outcome.evidence_level,
    source: outcome.source,
    labeler: outcome.labeler,
    blind: outcome.blind,
    recorded_at: recordedAt.toISOString(),
    correction_minutes: outcome.correction_minutes,
    note: outcome.note
  }
  return ledger.exclusive(async () => {
    if (!(await ledgerHasRecord(ledger.directory, record_key)) && !(await stored(record_key))) {
      throw new Error(`No JEV record ${record_key} exists on the selected runtime.`)
    }
    const duplicate = (await readOutcomeRows(ledger.directory)).some(
      (existing) =>
        existing.record_key === row.record_key &&
        existing.question_id === row.question_id &&
        existing.labeler === row.labeler &&
        at(existing.recorded_at) === at(row.recorded_at)
    )
    if (duplicate) {
      throw new Error(
        'This outcome is already recorded for the same record_key, question_id, labeler and recorded_at. A correction is a new row with its own recorded_at.'
      )
    }
    await ledger.append(JEV_OUTCOMES_FILE, `${JSON.stringify(row)}\n`)
    return { outcome: row, storage: { status: 'saved', file: JEV_OUTCOMES_FILE } }
  })
}
