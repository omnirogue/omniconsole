import type { WorkflowStep } from '../../../../shared/workflow-graph'
import {
  splitWorkflowReportRanking,
  type WorkflowReportRank
} from '../../../../shared/workflow-report-ranking'
import { graphConfirmedResult } from './graph-input-section'
import { graphPlural, type GraphStepRun } from './graph-plan-types'
import type { GraphInputSection, GraphTargetView } from './graph-prompts'
import type { GraphScope } from './graph-scope'
import { graphWebReportChecks } from './graph-web-citations'

/** The reviewed results a ranked write-up orders: every confirmed one must be in it. */
export function graphRankedKeys(targets: readonly GraphTargetView[]): {
  required: string[]
  known: string[]
} {
  return {
    required: targets.filter(graphConfirmedResult).map((target) => target.item.key),
    known: targets.map((target) => target.item.key)
  }
}

/** A ranked write-up's inputs name each result by key, so the ranking can point at it. */
export function graphKeyedSections(sections: readonly GraphInputSection[]): GraphInputSection[] {
  return sections.map((section) =>
    section.kind === 'targets' ? { ...section, keyed: true as const } : section
  )
}

export function graphRankedTargets(sections: readonly GraphInputSection[]): GraphTargetView[] {
  return sections.flatMap((section) => (section.kind === 'targets' ? section.targets : []))
}

/**
 * The report people read, its ranking, and a gap when the ranking left confirmed results out.
 * Lenient on purpose: a report is never lost over its ranking; what it did not rank follows the
 * ranked results by impact, and the gap says so.
 */
export function graphReportRanking(
  scope: GraphScope,
  step: WorkflowStep,
  markdown: string
): { markdown: string; ranking?: WorkflowReportRank[]; gap?: string } {
  const targets = step.inputs.flatMap((id) => {
    const output = scope.outputs.get(id)
    const input = scope.byId.get(id)
    // A failed review still hands its targets on (graph-step.ts), so the writer saw their keys.
    const run = output && 'run' in output ? output.run : undefined
    return run && input?.kind === 'review' && input.forEach
      ? (run.targets ?? []).map((target) => ({
          item: target.item,
          tally: target.tally,
          ...(target.unchecked ? { unchecked: true } : {}),
          ...(target.confirmedBy ? { confirmedBy: target.confirmedBy } : {}),
          ...(target.refutedBy ? { refutedBy: target.refutedBy } : {}),
          votes: []
        }))
      : []
  })
  const split = splitWorkflowReportRanking(markdown)
  if (!targets.length) {
    return { markdown: split.markdown }
  }
  const { required, known } = graphRankedKeys(targets)
  const seen = new Set<string>()
  const ranking = (split.ranking ?? [])
    .filter((row) => {
      const fresh = known.includes(row.key) && !seen.has(row.key)
      seen.add(row.key)
      return fresh
    })
    .map((row) => {
      // Checked after JSON decoding, so an escaped citation is never missed.
      const web = graphWebReportChecks(
        scope,
        `${step.title} (ranking)`,
        [row.why, row.next],
        markdown
      )
      return web ? { ...row, webChecks: web } : row
    })
  const missing = required.filter((key) => !seen.has(key)).length
  const gap = !missing
    ? undefined
    : !ranking.length
      ? `${step.title} did not rank the results, so they are listed by impact.`
      : `${step.title} left ${graphPlural(missing, 'confirmed result')} out of its ranking; they follow the ranked ones by impact.`
  return {
    markdown: split.markdown,
    ...(ranking.length ? { ranking } : {}),
    ...(gap ? { gap } : {})
  }
}

/** The answers in first place: more than one on a tie, none when no vote counted. */
export function graphRankingWinners(run: GraphStepRun) {
  const first = (run.standings ?? []).filter(
    (standing) => standing.votes > 0 && standing.place === 1
  )
  return (run.candidates ?? []).filter((entry) =>
    first.some((standing) => standing.label === entry.label)
  )
}

export function graphRankingDocument(run: GraphStepRun): string {
  const nameOf = (label: string) =>
    run.candidates?.find((entry) => entry.label === label)?.name ?? label
  const table = (run.standings ?? [])
    .map((standing) =>
      standing.votes
        ? `${standing.place}. ${nameOf(standing.label)}: average rank ${standing.averageRank.toFixed(2)} (${graphPlural(standing.votes, 'vote')})`
        : `-. ${nameOf(standing.label)}: not ranked`
    )
    .join('\n')
  const first = graphRankingWinners(run)
  const heading =
    first.length > 1
      ? first.map((entry) => `## Tied for first: ${entry.name}\n\n${entry.markdown}`)
      : first.map((entry) => `## Ranked first: ${entry.name}\n\n${entry.markdown}`)
  return [...heading, `## Rankings\n\n${table}`].join('\n\n')
}
