import type Database from '../../sqlite/sync-database'
import type { WorkflowContextRecordEntry } from '../../../shared/workflow-context-layout'
import { QUICK_DISCOVER_FIND_STEP } from '../../../shared/workflow-graph-quick-discover'
import { setAsideAs } from '../../../shared/discover-omnios-page'
import type { WorkflowRunTarget } from '../../../shared/workflow-run-result'
import { GRAPH_SEVERITIES, sameGraphItem, type GraphRawItem } from './graph/graph-items'

/**
 * The cross-run known list: what earlier completed runs of the same template on the same target
 * settled on, shown to the next run's finders as "report only if materially new". A graph run's
 * entries are its run result's targets: confirmed ones and those the person acted on, plus the
 * unverified ones labelled as such; refuted and set-aside ones never. It is read once at admission
 * and frozen into the snapshot, so a replay builds the same prompts. A Find report that repeats a
 * confirmed line exactly is held (holdRepeats); anything else is left to the finders.
 */
export const EARLIER_RUNS_MAX = 5
export const EARLIER_TITLES_MAX = 50
/** A title line is cut here, so 50 of them stay a small part of any prompt. */
export const EARLIER_TITLE_MAX_CHARS = 300
/** `OMNI_WORKFLOW_EARLIER_RUNS=0` (or off/false/no) turns the list off for every run on this host. */
export const EARLIER_RUNS_ENV = 'OMNI_WORKFLOW_EARLIER_RUNS'
export const EARLIER_RUNS_LABEL = 'Already reported in earlier runs; report only if materially new'
/** Appended to an earlier result no reviewer confirmed: it was reported, never shown to hold. */
export const EARLIER_UNCONFIRMED = ' [reported, not confirmed]'

/** The step whose reports later runs are shown, per graph template; other templates get none. */
const SEEDED_STEPS: Readonly<Record<string, string>> = {
  discover: 'find',
  'quick-discover': QUICK_DISCOVER_FIND_STEP
}
/** Audit's themes: novelty-merge's, or merge's for a run without novelty lenses. */
const AUDIT_THEME_CALLS = ['audit/novelty-merge', 'audit/merge'] as const

export type WorkflowEarlierFindings = {
  /** The graph step whose agents are shown the list. */
  step: string
  /** The earlier runs the titles came from, newest first. */
  runs: string[]
  /** One line each (title, then its location when it has one), newest run first. */
  titles: string[]
  /** Find reports repeating a line exactly are held; absent on lists frozen before the hold. */
  holdRepeats?: true
}

/** One earlier graph run as it settled: its run result's targets and the person's picks. */
export type WorkflowEarlierSettled = {
  targets: readonly WorkflowRunTarget[]
  /** Target keys picked Start or Dig deeper on the run's page (decisions.json). */
  actedOn: ReadonlySet<string>
}

/** Reads one earlier run's settled results; undefined or a throw leaves that run out. */
export type WorkflowEarlierSettledReader = (
  executionId: string
) => WorkflowEarlierSettled | undefined

/** What identifies a run's template and target; the same fields are read from earlier runs. */
export type WorkflowEarlierTarget = {
  template?: string
  workspaceId?: string
  context?: readonly WorkflowContextRecordEntry[]
  auditSource?: { file: string; format: string }
  /** The new run's goal: earlier titles that share its words are listed first. */
  goal?: string
}

/** Off when the environment says so; on otherwise. */
export function workflowEarlierRunsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EARLIER_RUNS_ENV]?.trim().toLowerCase()
  return !value || !['0', 'off', 'false', 'no'].includes(value)
}

/**
 * The target key: the workspace and every attached context folder without its commit (a later
 * commit of the same branch is the same target), or an Audit's corpus file and format.
 */
function targetKey(target: WorkflowEarlierTarget): string | undefined {
  if (target.auditSource) {
    return JSON.stringify(['audit', target.auditSource.file, target.auditSource.format])
  }
  if (!target.template || !SEEDED_STEPS[target.template] || !target.workspaceId) {
    return undefined
  }
  const context = (target.context ?? []).map((entry) =>
    Object.entries(entry)
      .filter(([key]) => key !== 'commit')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
  return JSON.stringify([target.template, target.workspaceId, context])
}

type EarlierRow = {
  id: string
  template: string | null
  workspaceId: string | null
  entries: string | null
  auditFile: string | null
  auditFormat: string | null
}

function parsed(text: string | null): unknown {
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function rowTarget(row: EarlierRow): WorkflowEarlierTarget {
  if (row.auditFile && row.auditFormat) {
    return { auditSource: { file: row.auditFile, format: row.auditFormat } }
  }
  const entries = parsed(row.entries)
  return {
    ...(row.template ? { template: row.template } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(Array.isArray(entries) ? { context: entries as WorkflowContextRecordEntry[] } : {})
  }
}

type Candidate = { item: GraphRawItem; line: string; rank: number[] }

const GOAL_WORD = /[\p{L}\p{N}]{4,}/gu
const COMMON_WORDS = new Set(
  'that this with from into when what which their there they them then than does have been were will would should could only also every each more most over under about after before your'.split(
    ' '
  )
)
const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(GOAL_WORD) ?? []).filter((word) => !COMMON_WORDS.has(word)))

/** One earlier graph run's settled targets: acted on, then confirmed, then unverified. */
function settledCandidates(settled: WorkflowEarlierSettled, goal: Set<string>): Candidate[] {
  return settled.targets.flatMap((target, order): Candidate[] => {
    const acted = settled.actedOn.has(target.key)
    if (!target.title || (!acted && setAsideAs(target))) {
      return []
    }
    const confirmed = acted || target.tally === 'confirmed'
    const item: GraphRawItem = {
      title: target.title,
      detail: target.detail,
      location: target.location,
      severity: target.severity
    }
    const shared = [...words(target.title)].filter((word) => goal.has(word)).length
    return [
      {
        item,
        line: titleLine(item, confirmed ? '' : EARLIER_UNCONFIRMED),
        rank: [
          acted ? 0 : confirmed ? 1 : 2,
          -shared,
          GRAPH_SEVERITIES.indexOf(item.severity),
          order
        ]
      }
    ]
  })
}

/** One earlier Audit run's final themes, as title-only reports. */
function auditReports(db: Database.Database, executionId: string): GraphRawItem[] {
  for (const callId of AUDIT_THEME_CALLS) {
    const row = db
      .prepare(
        `SELECT result_json AS result FROM local_workflow_calls
         WHERE execution_id = ? AND call_id = ? AND quarantined = 0 AND result_json IS NOT NULL`
      )
      .get(executionId, callId) as { result: string } | undefined
    const findings = (parsed(row?.result ?? null) as { findings?: unknown } | undefined)?.findings
    if (Array.isArray(findings)) {
      return (findings as { title?: unknown }[]).flatMap((finding) =>
        typeof finding?.title === 'string' && finding.title.trim()
          ? [{ title: finding.title.trim(), detail: '', location: '', severity: 'none' as const }]
          : []
      )
    }
  }
  return []
}

function titleLine(item: Pick<GraphRawItem, 'title' | 'location'>, label = ''): string {
  const line = item.location ? `${item.title} (${item.location})` : item.title
  const room = EARLIER_TITLE_MAX_CHARS - label.length
  return `${line.length > room ? `${line.slice(0, room - 1)}…` : line}${label}`
}

const exactLine = (line: string) => line.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The lines a Find report must repeat exactly to be held: those confirmed or acted on. A repeat of
 * one no reviewer confirmed is reviewed again, so it can still be confirmed.
 */
export function graphEarlierHold(snapshot: object): {
  earlierHold?: { step: string; lines: readonly string[] }
} {
  const earlier = (snapshot as { host?: { earlierFindings?: WorkflowEarlierFindings } }).host
    ?.earlierFindings
  return earlier?.holdRepeats && earlier.titles.some((line) => !line.endsWith(EARLIER_UNCONFIRMED))
    ? {
        earlierHold: {
          step: earlier.step,
          lines: earlier.titles.filter((line) => !line.endsWith(EARLIER_UNCONFIRMED)).map(exactLine)
        }
      }
    : {}
}

/** Whether a Find report repeats a held earlier line exactly. */
export function repeatsEarlierLine(lines: readonly string[], item: GraphRawItem): boolean {
  return !!item.title && lines.includes(exactLine(titleLine(item)))
}

/**
 * The cross-run known list for a run about to be admitted: the last EARLIER_RUNS_MAX completed,
 * non-isolated runs of the same template on the same target, newest first. Each run takes turns
 * adding its next entry, so every run gets a fair share of the EARLIER_TITLES_MAX lines; an entry
 * the app's same-item rule matches to one already listed is skipped. Within a run: acted on, then
 * confirmed, then unverified; then most words shared with the goal; then worst severity. A graph
 * run's verdicts come from `settled`; one it cannot read is left out. Undefined when the template
 * is never seeded or nothing earlier is listed. Read-only.
 */
export function readWorkflowEarlierFindings(
  db: Database.Database,
  target: WorkflowEarlierTarget,
  settled?: WorkflowEarlierSettledReader
): WorkflowEarlierFindings | undefined {
  const key = targetKey(target)
  const step = target.auditSource ? 'novelty' : SEEDED_STEPS[target.template ?? '']
  if (!key || !step) {
    return undefined
  }
  // SQLite reads the few JSON fields, so no earlier snapshot (an Audit's holds its corpus) is
  // parsed here in full.
  const rows = db
    .prepare(
      `SELECT id,
         json_extract(snapshot_json, '$.snapshot.graph.spec.template') AS template,
         json_extract(snapshot_json, '$.snapshot.host.workspaceId') AS workspaceId,
         json_extract(snapshot_json, '$.snapshot.host.context.entries') AS entries,
         json_extract(snapshot_json, '$.snapshot.audit.sourceFile') AS auditFile,
         json_extract(snapshot_json, '$.snapshot.audit.format') AS auditFormat
       FROM local_workflow_executions
       WHERE state = 'completed'
         AND json_extract(snapshot_json, '$.snapshot.host.isolated') IS NULL
         AND (json_extract(snapshot_json, '$.snapshot.graph.spec.template') = ?
           OR json_extract(snapshot_json, '$.snapshot.audit.sourceFile') = ?)
       ORDER BY json_extract(snapshot_json, '$.snapshot.host.startedAt') DESC, rowid DESC`
    )
    .all(target.template ?? null, target.auditSource?.file ?? null) as EarlierRow[]
  const runs = rows.filter((row) => targetKey(rowTarget(row)) === key).slice(0, EARLIER_RUNS_MAX)
  const goal = words(target.goal ?? '')
  const queues = runs.map((run) => {
    const candidates = target.auditSource
      ? auditReports(db, run.id).map((item, order) => ({
          item,
          line: titleLine(item),
          rank: [GRAPH_SEVERITIES.indexOf(item.severity), order]
        }))
      : settledCandidates(readSettled(settled, run.id) ?? { targets: [], actedOn: new Set() }, goal)
    candidates.sort((a, b) => compareRanks(a.rank, b.rank))
    return { id: run.id, candidates, next: 0 }
  })
  const listed: (Candidate & { run: number; position: number })[] = []
  for (let added = true; added && listed.length < EARLIER_TITLES_MAX;) {
    added = false
    for (const [run, queue] of queues.entries()) {
      while (listed.length < EARLIER_TITLES_MAX && queue.next < queue.candidates.length) {
        const position = queue.next++
        const candidate = queue.candidates[position]
        if (!listed.some((entry) => sameGraphItem(entry.item, candidate.item))) {
          listed.push({ ...candidate, run, position })
          added = true
          break
        }
      }
    }
  }
  listed.sort((a, b) => a.run - b.run || a.position - b.position)
  const used = [...new Set(listed.map((entry) => queues[entry.run].id))]
  return listed.length
    ? {
        step,
        runs: used,
        titles: listed.map((entry) => entry.line),
        ...(target.auditSource ? {} : { holdRepeats: true as const })
      }
    : undefined
}

function readSettled(
  settled: WorkflowEarlierSettledReader | undefined,
  executionId: string
): WorkflowEarlierSettled | undefined {
  try {
    return settled?.(executionId)
  } catch {
    // An earlier run whose verdicts cannot be read is left out, never listed unverdicted.
    return undefined
  }
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (const [index, value] of a.entries()) {
    if (value !== b[index]) {
      return value - b[index]
    }
  }
  return 0
}

/** The graph config field for a run admitted with a list; nothing for any other run. */
export function graphEarlierFindings(snapshot: {
  host?: { earlierFindings?: WorkflowEarlierFindings }
}): { earlier?: { step: string; titles: readonly string[] } } {
  const earlier = snapshot.host?.earlierFindings
  return earlier?.titles.length ? { earlier: { step: earlier.step, titles: earlier.titles } } : {}
}
