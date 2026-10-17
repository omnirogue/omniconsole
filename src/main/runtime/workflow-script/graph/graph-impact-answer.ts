import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { mergeGraphReport, type GraphItem } from './graph-items'

/**
 * The impact triage's answer: an impact per result and, when the step merges repeats, the earlier
 * result each one shares a root cause with. The old engine grouped repeats before verifying; one
 * triage call now does both, so no call is added for it.
 */
export type GraphImpactRow = { key: string; impact: number; why: string; sameAs?: string }

export const graphMergesRootCauses = (step: WorkflowStep) => step.forEach?.merge === 'root-cause'

export function graphImpactCallId(step: WorkflowStep, round: number, inLoop: boolean): string {
  return [step.id, inLoop ? `r${round}` : '', 'impact'].filter(Boolean).join('/')
}

export function graphImpactSchema(merge: boolean) {
  const row = {
    key: { type: 'string' },
    impact: { type: 'integer' },
    why: { type: 'string' },
    ...(merge ? { sameAs: { type: 'string' } } : {})
  }
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: row,
          required: Object.keys(row),
          additionalProperties: false
        }
      }
    },
    required: ['items'],
    additionalProperties: false
  }
}

export const GRAPH_ROOT_CAUSE_RULES = [
  'Also mark repeats, so each result is checked once: when a result describes the same claim or proposal as an EARLIER listed result (the same mechanism and intended outcome, so that one action addresses both), set sameAs to that earlier result\'s key; otherwise set sameAs to "".',
  'Sharing a file, nearby lines, a symptom or a severity is not enough. Keep distinct claims or proposals apart, even on the same lines, and leave sameAs empty when unsure.'
].join('\n')

export const GRAPH_LEGACY_ROOT_CAUSE_RULES = [
  'Also mark repeats, so each defect is checked once: when a result describes the same defect as an EARLIER listed result (the same violated condition: the same missing check, wrong comparison, unawaited call, race or unsafe input, so that one fix removes both), set sameAs to that earlier result\'s key; otherwise set sameAs to "".',
  'Sharing a file, nearby lines, a symptom or a severity is not enough. Keep distinct defects apart, even on the same lines, and leave sameAs empty when unsure.'
].join('\n')

export function graphImpactRows(value: unknown): GraphImpactRow[] | undefined {
  const items = (value as { items?: unknown } | null)?.items
  return Array.isArray(items) ? (items as GraphImpactRow[]) : undefined
}

export function graphImpactProblem(
  value: unknown,
  keys: readonly string[],
  merge: boolean,
  legacy = false
): string | null {
  const rows = graphImpactRows(value)
  if (!rows) {
    return 'Return {"items": [...]} with one entry per finding.'
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (!keys.includes(row.key) || seen.has(row.key)) {
      return `Every key must be one of the listed findings, exactly once (got "${row.key}").`
    }
    if (!Number.isInteger(row.impact) || row.impact < 1 || row.impact > 5) {
      return `Impact must be a whole number from 1 to 5 (got ${row.impact} for ${row.key}).`
    }
    // Pointing only backwards keeps every group a tree with the earliest result at its root.
    if (
      merge &&
      row.sameAs &&
      (!keys.includes(row.sameAs) || keys.indexOf(row.sameAs) >= keys.indexOf(row.key))
    ) {
      return `sameAs must be the key of an earlier listed result, or "" (got "${row.sameAs}" for ${row.key}).`
    }
    seen.add(row.key)
  }
  return legacy && seen.size !== keys.length
    ? `Rate every finding: ${keys.length - seen.size} were missing.`
    : null
}

/**
 * Each result the triage marked as a repeat, merged into the earliest result of its group: its
 * reports kept as merged claims, its finders kept (so no finder's family reviews it alone), the
 * higher impact kept. Results never merge on doubt: an unknown or later key merges nothing.
 */
export function graphMergeRootCauses(
  items: readonly GraphItem[],
  rows: readonly GraphImpactRow[]
): { items: GraphItem[]; merged: number } {
  const keys = items.map((item) => item.key)
  const parent = new Map(
    rows.flatMap((row) =>
      row.sameAs && keys.includes(row.sameAs) && keys.indexOf(row.sameAs) < keys.indexOf(row.key)
        ? [[row.key, row.sameAs] as const]
        : []
    )
  )
  const root = (key: string): string => {
    const up = parent.get(key)
    return up ? root(up) : key
  }
  // Only a result that absorbs others is copied; every other one passes through untouched.
  const leaders = new Map<string, GraphItem>()
  for (const item of items) {
    if (!parent.has(item.key)) {
      continue
    }
    const top = root(item.key)
    const original = items.find((entry) => entry.key === top)!
    const leader = leaders.get(top) ?? { ...original }
    leaders.set(top, leader)
    // Counted apart from the claims kept: identical copies of a repeat count, but are not kept.
    const repeats = leader.repeats + 1 + item.repeats
    for (const report of [item, ...(item.alsoReported ?? [])]) {
      mergeGraphReport(leader, {
        title: report.title,
        detail: report.detail,
        location: report.location,
        severity: report.severity,
        ...(report.excerpt ? { excerpt: report.excerpt } : {}),
        ...(report.trigger ? { trigger: report.trigger } : {}),
        ...(report.fix ? { fix: report.fix } : {})
      })
    }
    if (
      ['found', 'moved'].includes(item.evidence?.status ?? '') &&
      !['found', 'moved'].includes(leader.evidence?.status ?? '')
    ) {
      leader.evidence = {
        ...item.evidence!,
        location: item.evidence?.location ?? item.location,
        excerpt: item.evidence?.excerpt ?? item.excerpt
      }
    }
    leader.repeats = repeats
    leader.alsoMerged = [...(leader.alsoMerged ?? []), item.key, ...(item.alsoMerged ?? [])]
    const finders = [item.sourceCallId, ...(item.alsoFrom ?? [])].filter(
      (id) => id !== leader.sourceCallId && !leader.alsoFrom?.includes(id)
    )
    if (finders.length) {
      leader.alsoFrom = [...(leader.alsoFrom ?? []), ...new Set(finders)]
    }
    if ((item.impact?.score ?? 0) > (leader.impact?.score ?? 0)) {
      leader.impact = item.impact
    }
  }
  return {
    items: items.flatMap((item) => (parent.has(item.key) ? [] : [leaders.get(item.key) ?? item])),
    merged: parent.size
  }
}

/**
 * A loop's aggregate copy of a result with what later rounds reported of the repeats merged into
 * it: those reports are filed under the repeat's own key, so without this they would reach
 * neither the report nor the results. Each repeat counts once, plus its own copies.
 */
export function graphWithMergedRepeats(
  item: GraphItem,
  copyOf: (key: string) => GraphItem | undefined
): GraphItem {
  const members = (item.alsoMerged ?? []).flatMap((key) => copyOf(key) ?? [])
  if (!members.length) {
    return item
  }
  const merged = { ...item }
  let repeats = item.repeats
  for (const member of members) {
    for (const report of [member, ...(member.alsoReported ?? [])]) {
      mergeGraphReport(merged, {
        title: report.title,
        detail: report.detail,
        location: report.location,
        severity: report.severity,
        ...(report.excerpt ? { excerpt: report.excerpt } : {}),
        ...(report.trigger ? { trigger: report.trigger } : {}),
        ...(report.fix ? { fix: report.fix } : {})
      })
    }
    repeats += 1 + member.repeats
    const finders = [member.sourceCallId, ...(member.alsoFrom ?? [])].filter(
      (id) => id !== merged.sourceCallId && !merged.alsoFrom?.includes(id)
    )
    if (finders.length) {
      merged.alsoFrom = [...(merged.alsoFrom ?? []), ...new Set(finders)]
    }
  }
  merged.repeats = repeats
  return merged
}
