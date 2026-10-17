import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { WorkflowJudgingStatsRequest } from '../../../shared/workflow-judging-stats'
import type { GraphJudgingGate } from './graph/graph-judging-gates'
import type { GraphJudgingEntry, GraphJudgingLine } from './graph/graph-judging-record'
import type { GraphJevRecord } from './graph/graph-jev-store'

/** The shared record every settled live run appends to (graph-judging-record.ts). */
export const WORKFLOW_JUDGING_FILE = 'workflow-judging.jsonl'

export type JudgingLinesRead = {
  file: string
  lines: GraphJudgingLine[]
  read: number
  skipped: number
  duplicates: number
  matched: number
  joined: number
}

export const isGateLine = (line: GraphJudgingLine): line is GraphJudgingGate => line.kind === 'gate'

/** A parsed line is one of ours when it names the run, step and round every line has. */
function judgingLine(raw: string): GraphJudgingLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined
  }
  const line = parsed as Record<string, unknown>
  const named =
    typeof line.executionId === 'string' &&
    typeof line.stepId === 'string' &&
    typeof line.round === 'number' &&
    typeof line.at === 'number' &&
    typeof line.template === 'string'
  if (!named) {
    return undefined
  }
  if (line.kind === 'gate') {
    return typeof line.gate === 'string' && typeof line.decision === 'string'
      ? (line as unknown as GraphJudgingGate)
      : undefined
  }
  return Array.isArray(line.candidates) && Array.isArray(line.models)
    ? (line as unknown as GraphJudgingEntry)
    : undefined
}

/** A run's own ballots, read once; an unreadable or missing file reads as none. */
function ballotsOf(root: string, executionId: string): Record<string, GraphJevRecord> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) {
    return {}
  }
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, executionId, 'jev-ballots.json'), 'utf8')
    ) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, GraphJevRecord>) : {}
  } catch {
    return {}
  }
}

/**
 * An older Rank line says nothing about JEV's method or tokens; its run's ballots file does,
 * under `step/jev` outside a loop and `step/r<round>/jev` inside one. Nothing else is joined.
 */
function joinBallot(
  line: GraphJudgingEntry,
  ballots: (executionId: string) => Record<string, GraphJevRecord>
): GraphJudgingEntry | undefined {
  if (!line.jev || (line.jev.method && line.jev.usage)) {
    return undefined
  }
  const records = ballots(line.executionId)
  const record = records[`${line.stepId}/jev`] ?? records[`${line.stepId}/r${line.round}/jev`]
  const outcome = record?.outcome
  const value =
    outcome && 'value' in outcome
      ? (outcome.value as { judgment?: { method?: string; usage?: unknown } } | null)
      : null
  const judgment = value?.judgment
  if (!judgment || typeof judgment !== 'object') {
    return undefined
  }
  const method = judgment.method === 'rubric' || judgment.method === 'pairwise'
  const usage = judgment.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
  const tokens =
    usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
      : undefined
  if (!method && !tokens) {
    return undefined
  }
  return {
    ...line,
    jev: {
      ...line.jev,
      ...(method && !line.jev.method ? { method: judgment.method as 'rubric' | 'pairwise' } : {}),
      ...(tokens && !line.jev.usage ? { usage: tokens } : {})
    }
  }
}

const lineKey = (line: GraphJudgingLine) =>
  [line.executionId, line.stepId, line.round, isGateLine(line) ? line.gate : 'rank'].join('|')

/**
 * Streams the record, skipping a torn last line (or any line that is not one of ours), keeping
 * the first of any repeated run, step and round, and joining older lines from their ballots.
 * Read-only: the record is evidence, and nothing here may change it.
 */
export async function readJudgingLines(
  root: string,
  request: WorkflowJudgingStatsRequest
): Promise<JudgingLinesRead> {
  const file = join(root, WORKFLOW_JUDGING_FILE)
  const seen = new Set<string>()
  const ballotCache = new Map<string, Record<string, GraphJevRecord>>()
  const ballots = (executionId: string) => {
    let records = ballotCache.get(executionId)
    if (!records) {
      records = ballotsOf(root, executionId)
      ballotCache.set(executionId, records)
    }
    return records
  }
  const result: JudgingLinesRead = {
    file,
    lines: [],
    read: 0,
    skipped: 0,
    duplicates: 0,
    matched: 0,
    joined: 0
  }
  // A missing record is an empty one; every other read error is the caller's to see.
  if (!existsSync(file)) {
    return result
  }
  const stream = createReadStream(file, { encoding: 'utf8' })
  try {
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const raw of reader) {
      if (!raw.trim()) {
        continue
      }
      result.read++
      const line = judgingLine(raw)
      if (!line) {
        result.skipped++
        continue
      }
      const key = lineKey(line)
      if (seen.has(key)) {
        result.duplicates++
        continue
      }
      seen.add(key)
      if (
        (request.template && line.template !== request.template) ||
        (request.since !== undefined && line.at < request.since)
      ) {
        continue
      }
      result.matched++
      const joined = isGateLine(line) ? undefined : joinBallot(line, ballots)
      if (joined) {
        result.joined++
      }
      result.lines.push(joined ?? line)
    }
  } finally {
    stream.destroy()
  }
  return result
}
