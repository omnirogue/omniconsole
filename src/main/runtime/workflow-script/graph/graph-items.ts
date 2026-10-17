import { discoverV7TitleWords } from '../presets/discover-v7-dedup'
import type { JsonSchema } from '../../../../shared/json-schema-validate'
import type { GraphEvidenceCheck } from './graph-evidence-check'

export type GraphSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none'
export const GRAPH_SEVERITIES: readonly GraphSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'none'
]

/** One entry of a list a Do step returned, after dedup. */
export type GraphItem = {
  /** Stable within the run: `<stepId>.r<round>.<n>`, numbered in report order. */
  key: string
  title: string
  detail: string
  location: string
  severity: GraphSeverity
  round: number
  /** The call that reported it first. */
  sourceCallId: string
  /** Other calls whose reports were merged into it within its round: its other finders. */
  alsoFrom?: string[]
  /** Keys of results merged into it as repeats of its root cause (graph-impact-answer.ts). */
  alsoMerged?: string[]
  /** How many later reports described the same item and were merged into it. */
  repeats: number
  /**
   * Every merged report except exact copies. Merging is only a saving: word overlap cannot tell a
   * claim from its opposite, so a merged report is kept and shown with the item, never dropped.
   */
  alsoReported?: GraphRawItem[]
  /** The severity it was first reported with, once a later report raised it. */
  reportedSeverity?: GraphSeverity
  /** The upstream item this one was reported for (a finding's area), if any. */
  parentKey?: string
  /** JEV's 0–4 score when a screen ranked the items for review (graph-triage.ts). */
  jev?: { score: number }
  /** A frontier triage's 1–5 impact rating, when it ordered the items (graph-verify-order.ts). */
  impact?: { score: number; why: string }
  /** With `list.evidence`: the finder's verbatim quote and what triggers the result. */
  excerpt?: string
  trigger?: string
  fix?: string
  /** The app's check of the quote against the file, before any reviewer ran. */
  evidence?: GraphEvidenceCheck
}

export type GraphRawItem = Pick<GraphItem, 'title' | 'detail' | 'location' | 'severity'> &
  Pick<GraphItem, 'excerpt' | 'trigger' | 'fix'>

/** The longest quote a finder may give; longer code is quoted in parts joined by "...". */
export const GRAPH_EXCERPT_MAX_CHARS = 1200
const TRIGGER_MAX_CHARS = 400

/** Structured list output; optional fix text also accepts earlier finder answers. */
export function graphListSchema(maxItems: number, evidence = false, salvage = false): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        minItems: 0,
        maxItems,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', ...(salvage ? {} : { minLength: 1 }), maxLength: 240 },
            detail: { type: 'string', ...(salvage ? {} : { minLength: 1 }), maxLength: 6000 },
            location: { type: 'string', maxLength: 1000 },
            severity: { type: 'string', enum: [...GRAPH_SEVERITIES] },
            ...(evidence
              ? {
                  excerpt: { type: 'string', maxLength: GRAPH_EXCERPT_MAX_CHARS },
                  trigger: { type: 'string', maxLength: TRIGGER_MAX_CHARS },
                  ...(salvage ? { fix: { type: 'string', maxLength: 600 } } : {})
                }
              : {})
          },
          required: [
            'title',
            'detail',
            'location',
            'severity',
            ...(evidence ? ['excerpt', 'trigger'] : [])
          ]
        }
      }
    },
    required: ['items']
  }
}

/** `evidence`: the list step asked for quotes; without it an item never carries one. */
export function readGraphItems(value: unknown, evidence = false): GraphRawItem[] | undefined {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
    return undefined
  }
  return ((value as { items: unknown[] }).items as GraphRawItem[])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? '').trim(),
      detail: String(item.detail ?? '').trim(),
      location: String(item.location ?? '').trim(),
      severity: GRAPH_SEVERITIES.includes(item.severity) ? item.severity : 'none',
      ...(evidence && typeof item.excerpt === 'string' && item.excerpt.trim()
        ? { excerpt: item.excerpt.slice(0, GRAPH_EXCERPT_MAX_CHARS) }
        : {}),
      ...(evidence && typeof item.fix === 'string' && item.fix.trim()
        ? { fix: item.fix.trim().slice(0, 600) }
        : {}),
      ...(evidence && typeof item.trigger === 'string' && item.trigger.trim()
        ? { trigger: item.trigger.trim().slice(0, TRIGGER_MAX_CHARS) }
        : {})
    }))
}

export const badGraphItem = (item: GraphRawItem) =>
  !item.title ||
  (PLACEHOLDER_TITLE.test(item.title) && (!item.location || item.severity === 'none')) ||
  item.detail.length < 12

const PLACEHOLDER_TITLE =
  /^(n\/?a|none|nothing|no (?:issues?|findings?|defects?|bugs?)(?: found)?|todo|tbd|placeholder|example|\.+|-+)\.?$/i

/**
 * Placeholder answers a model gives instead of an honest empty list. A placeholder title counts
 * only without a place or a severity: a real defect may quote a message like "No issues found".
 */
export function graphItemsProblem(value: unknown, salvage = false): string | null {
  const items = readGraphItems(value)
  if (!items) {
    return 'Return an object with an "items" list.'
  }
  const vague = items.find(
    (item) =>
      !item.title ||
      (PLACEHOLDER_TITLE.test(item.title) && (!item.location || item.severity === 'none')) ||
      item.detail.length < 12
  )
  return vague && (!salvage || !items.some((item) => !badGraphItem(item)))
    ? `Item "${vague.title}" is a placeholder or has no real detail. Return real items only, or an empty list.`
    : null
}

const NEAR_LINES = 12

function parseLocation(location: string): { file: string; line?: number } | undefined {
  const first = location.split(/[,;\s]+/).find(Boolean)
  if (!first) {
    return undefined
  }
  const match = /^(.*?)(?::(\d+))?(?:[-–]\d+)?$/.exec(first.replace(/^\.\//, ''))
  if (!match || !match[1]) {
    return undefined
  }
  return { file: match[1], ...(match[2] ? { line: Number(match[2]) } : {}) }
}

const NEGATION = /\b(?:not|no|never|without|cannot|can't|doesn't|isn't|won't|missing)\b/i

function titleOverlap(left: string, right: string): number {
  // Stopword removal drops negations, so a title and its opposite would look the same.
  if (NEGATION.test(left) !== NEGATION.test(right)) {
    return 0
  }
  const a = discoverV7TitleWords(left)
  const b = discoverV7TitleWords(right)
  if (!a.size || !b.size) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0
  }
  const shared = [...a].filter((word) => b.has(word)).length
  return shared / (a.size + b.size - shared)
}

/**
 * Two reports describe the same item when they name the same place (same file, lines within 12)
 * and share half their title words, or, without a place, share most of their title words. Pure,
 * so the program and its replay merge the same items whatever order agents finished in.
 */
export function sameGraphItem(left: GraphRawItem, right: GraphRawItem): boolean {
  const a = parseLocation(left.location)
  const b = parseLocation(right.location)
  if (a && b) {
    if (a.file !== b.file) {
      return false
    }
    if (a.line !== undefined && b.line !== undefined && Math.abs(a.line - b.line) > NEAR_LINES) {
      return false
    }
    return titleOverlap(left.title, right.title) >= 0.5
  }
  if (a || b) {
    return titleOverlap(left.title, right.title) >= 0.8
  }
  return titleOverlap(left.title, right.title) >= 0.7
}

/** Only an exact claim after whitespace normalization can inherit another report's verdict. */
export function sameGraphClaim(left: GraphRawItem, right: GraphRawItem): boolean {
  const normalized = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
  return (['title', 'detail', 'location', 'excerpt', 'trigger', 'fix'] as const).every(
    (field) => normalized(left[field]) === normalized(right[field])
  )
}

export function graphSeverityRank(severity: GraphSeverity): number {
  return GRAPH_SEVERITIES.indexOf(severity)
}

/** Only a byte-for-byte copy (every field, trimmed) carries nothing new; case, place and
 * wording can all matter (`cacheKey` is not `CacheKey`), so anything else is kept. */
export const sameGraphReport = (left: GraphRawItem, right: GraphRawItem) =>
  left.title === right.title &&
  left.detail === right.detail &&
  left.location === right.location &&
  left.severity === right.severity &&
  left.excerpt === right.excerpt &&
  left.trigger === right.trigger &&
  left.fix === right.fix

/**
 * Merges a later report into an item: counts it, raises the severity if the report rates it
 * worse (never lowers it), and keeps the report unless it is an exact copy of one already held.
 * The item passed in must be the caller's own object: a round's record is never changed.
 */
export function mergeGraphReport(item: GraphItem, report: GraphRawItem): void {
  item.repeats++
  // Compared with the item as it was first written, so a raised severity never hides a report.
  const asWritten = { ...item, severity: item.reportedSeverity ?? item.severity }
  if (![asWritten, ...(item.alsoReported ?? [])].some((held) => sameGraphReport(held, report))) {
    item.alsoReported = [...(item.alsoReported ?? []), report]
  }
  if (graphSeverityRank(report.severity) < graphSeverityRank(item.severity)) {
    item.reportedSeverity ??= item.severity
    item.severity = report.severity
  }
}

/** A report is the same item as one held when it matches its first wording or any later one. */
export function graphMatchesItem(item: GraphItem, report: GraphRawItem): boolean {
  return (
    sameGraphItem(item, report) ||
    (item.alsoReported ?? []).some((other) => sameGraphItem(other, report))
  )
}

/**
 * Copies of items with every later report of each (by item key) merged in. The items passed in
 * are left as they were, so a round's record and the prompts built from it never change.
 */
export function graphMergeLaterReports(
  items: readonly GraphItem[],
  reports: readonly { key: string; report: GraphRawItem; from?: string }[]
): GraphItem[] {
  const copies = items.map((item) => ({ ...item }))
  const byKey = new Map(copies.map((item) => [item.key, item]))
  for (const { key, report, from } of reports) {
    const item = byKey.get(key)
    if (item) {
      mergeGraphReport(item, report)
      if (from && from !== item.sourceCallId && !item.alsoFrom?.includes(from)) {
        item.alsoFrom = [...(item.alsoFrom ?? []), from]
      }
    }
  }
  return copies
}

function describe(item: GraphRawItem & { reportedSeverity?: GraphSeverity }): string {
  const where = item.location ? ` (${item.location})` : ''
  const first = item.reportedSeverity ? `; first reported as ${item.reportedSeverity}` : ''
  const severity = item.severity !== 'none' ? ` [${item.severity}${first}]` : ''
  return `**${item.title}**${where}${severity}`
}

/**
 * An item with every report merged into it, in full. Callers pass it through the prompt budget,
 * which is the one place a long input is cut, and every cut is stated.
 */
export function formatGraphItem(
  item: Pick<
    GraphItem,
    | 'title'
    | 'detail'
    | 'location'
    | 'severity'
    | 'alsoReported'
    | 'reportedSeverity'
    | 'excerpt'
    | 'trigger'
    | 'fix'
  >,
  legacy = false
): string {
  const head = `${describe(item)}\n${item.detail}`
  const others = item.alsoReported ?? []
  return others.length
    ? [
        head,
        `Also reported, merged into this item as the same one (${others.length}; if any is a different claim, say so and judge it too):`,
        ...others.map((other) =>
          [
            `- ${describe(other)}\n  ${other.detail}`,
            ...(!legacy && other.trigger ? [`  Trigger: ${other.trigger}`] : []),
            ...(!legacy && other.excerpt ? [`  Excerpt: ${other.excerpt}`] : []),
            ...(!legacy && other.fix ? [`  Fix: ${other.fix}`] : [])
          ].join('\n')
        )
      ].join('\n')
    : head
}

/** The titles of an item and of every report merged into it, for "already reported" lists. */
export function graphItemTitles(item: Pick<GraphItem, 'title' | 'location' | 'alsoReported'>) {
  const where = (entry: GraphRawItem | typeof item) =>
    entry.location ? ` (${entry.location})` : ''
  return [
    `- ${item.title}${where(item)}`,
    ...(item.alsoReported ?? []).map(
      (other) => `  - also reported as: ${other.title}${where(other)}`
    )
  ].join('\n')
}
