import { discoverV7Plural, type DiscoverV7Severity } from './discover-v7-plan'

export type DiscoverV7ReportItem = {
  rank: number
  title: string
  location: string
  severity: DiscoverV7Severity
  scenario: string
  fix: string
  findingIds: string[]
  parallelSafe: boolean
}
export type DiscoverV7Report = {
  summary: string
  items: DiscoverV7ReportItem[]
  refutedIds: string[]
  unverifiedIds: string[]
}

/**
 * Every confirmed id lands in exactly one ranked item; the ranker may not invent ids. Its refuted
 * and unverified lists are not checked: the program replaces them with the lists the votes decide,
 * so nothing the ranker puts there can give a defect a second outcome or fail the run.
 */
export function discoverV7RankProblem(
  value: unknown,
  confirmedIds: readonly string[]
): string | null {
  const report = value as DiscoverV7Report
  const confirmed = new Set(confirmedIds)
  const seen = new Map<string, number>()
  for (const item of report.items) {
    for (const id of item.findingIds) {
      if (!confirmed.has(id)) {
        return `Ranked item "${item.title}" cites ${id}, which is not a confirmed finding`
      }
      seen.set(id, (seen.get(id) ?? 0) + 1)
    }
  }
  const misplaced = confirmedIds.filter((id) => seen.get(id) !== 1)
  return misplaced.length
    ? `Each confirmed finding must appear in exactly one item: ${misplaced.join(', ')}`
    : null
}

export type DiscoverV7SummaryCounts = {
  found: number
  duplicates: number
  refuted: number
  unverified: number
  /** Finder jobs that returned a batch, and those that returned nothing. */
  searched: number
  failed: number
}

/** Written in code when nothing was confirmed; it never hides finders that returned nothing. */
export function discoverV7EmptySummary(counts: DiscoverV7SummaryCounts): string {
  const gap = counts.failed
    ? ` ${counts.failed} of ${discoverV7Plural(counts.searched + counts.failed, 'finder job', 'finder jobs')} returned nothing, so part of the code was not searched.`
    : ''
  if (!counts.found) {
    return `Discover found no defects in the areas it inspected.${gap}`
  }
  const distinct = counts.found - counts.duplicates
  const duplicates = counts.duplicates
    ? ` (plus ${discoverV7Plural(counts.duplicates, 'repeat', 'repeats')})`
    : ''
  return `No defect was confirmed. Finders reported ${discoverV7Plural(distinct, 'finding', 'findings')}${duplicates}: ${counts.refuted} refuted, ${counts.unverified} unverified.${gap}`
}

/** The ranker's overview under counts written in code (models miscount); a heading stays on top. */
export function discoverV7RankedSummary(
  report: Pick<DiscoverV7Report, 'summary' | 'items'>,
  counts: { confirmed: number; refuted: number; unverified: number }
): string {
  const line = `${discoverV7Plural(counts.confirmed, 'confirmed finding', 'confirmed findings')} in ${discoverV7Plural(report.items.length, 'ranked item', 'ranked items')}; ${counts.refuted} refuted, ${counts.unverified} unverified.`
  const summary = report.summary.trim()
  const heading = /^#{1,6}[ \t][^\n]*/.exec(summary)?.[0]
  const body = heading ? summary.slice(heading.length).trim() : summary
  return [heading, line, body].filter(Boolean).join('\n\n')
}

export function sortDiscoverV7Items(
  items: readonly DiscoverV7ReportItem[]
): DiscoverV7ReportItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.rank - right.item.rank || left.index - right.index)
    .map(({ item }) => item)
}

const SEVERITY: Record<DiscoverV7Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low'
}

type Entry = { id: string; title: string; location: string }

function listing(title: string, entries: readonly Entry[]): string[] {
  return entries.length
    ? [
        `## ${title}`,
        entries
          .map((entry) => `- \`${entry.id}\` ${entry.title} (\`${entry.location}\`)`)
          .join('\n')
      ]
    : []
}

/** Readable report for Copy / Save as file. */
export function discoverV7ReportMarkdown(
  report: Pick<DiscoverV7Report, 'summary' | 'items'>,
  refuted: readonly Entry[],
  unverified: readonly Entry[]
): string {
  const items = sortDiscoverV7Items(report.items).map((item, index) =>
    [
      `### ${index + 1}. ${item.title}`,
      `**${SEVERITY[item.severity] ?? item.severity}** · \`${item.location}\` · ${item.parallelSafe ? 'Can run in parallel' : 'Must be sequenced'}`,
      `**Scenario:** ${item.scenario}`,
      `**Fix:** ${item.fix}`,
      `Findings: ${item.findingIds.map((id) => `\`${id}\``).join(', ')}`
    ].join('\n\n')
  )
  return [
    '# Discover report',
    report.summary,
    ...(items.length ? ['## Confirmed', ...items] : []),
    ...listing('Refuted', refuted),
    ...listing('Unverified', unverified)
  ].join('\n\n')
}
