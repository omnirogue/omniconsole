import type {
  LocalWorkflowCallView,
  LocalWorkflowDiscoverRun,
  LocalWorkflowView
} from '../../../shared/local-workflow-view'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  assessDiscoverVotes,
  selectDiscoverFindings,
  type FindingBatch,
  type FindingSource,
  type FindingVote
} from './presets/discover-assessment'
import {
  type ReviewedFinding,
  validateDiscoverReviewedRanking
} from './presets/discover-reviewed-ranking'
import {
  consensusDiscoverClusters,
  limitDiscoverSelection,
  type DiscoverClusterVote
} from './presets/discover-clustering'
import {
  discoverV7ResultMarkdown,
  projectDiscoverV7Run,
  settleFinishedDiscoverRun
} from './local-workflow-discover-run'
import { discoverV7CallSeatId } from './local-workflow-discover-replay'
import { projectLegacyDiscoverRun } from './local-workflow-discover-legacy-run'
import { DISCOVER_REVISION } from './workflow-program-revisions'

export { discoverStageDefinitions } from './local-workflow-discover-stages'

type Ranking = {
  summary: string
  ranking: { findingId: string; reason: string; nextAction: string; finding?: ReviewedFinding }[]
}
const sourceKey = (source: FindingSource): string =>
  JSON.stringify([source.dimension, source.index, source.producer])

/** Reconstructs selection and verdicts from accepted evidence, including incomplete reviews. */
export function projectDiscoverEvidence(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>,
  completed: boolean
): Pick<LocalWorkflowView, 'findings' | 'discoverCounts' | 'result'> {
  const config = snapshot.discover
  if (snapshot.discoverProgramRevision === DISCOVER_REVISION) {
    // Revision 7 projects through discoverRun; the legacy evidence fields stay empty.
    return {}
  }
  if (!config) {
    throw new Error('Missing frozen Discover configuration')
  }
  const batches = config.dimensions.map((dimension) => results.get(`discover/${dimension}`))
  if (batches.some((batch) => batch === undefined)) {
    return {}
  }
  // Revision 5 (frozen) and revision 6 (working, reviewed ranking) share the post-cluster quota.
  const usesPostClusterLimit =
    snapshot.discoverProgramRevision === 5 || snapshot.discoverProgramRevision === 6
  let selection = selectDiscoverFindings(batches as FindingBatch[], {
    ...config,
    maxCandidates: usesPostClusterLimit && config.maxCandidates > 1 ? 12 : config.maxCandidates,
    revision:
      snapshot.discoverProgramRevision === 4
        ? 2
        : usesPostClusterLimit
          ? 5
          : (snapshot.discoverProgramRevision ?? 1),
    finderId: snapshot.seats[0].id
  })
  if (
    (snapshot.discoverProgramRevision === 4 || usesPostClusterLimit) &&
    selection.selected.length > 1
  ) {
    const first = results.get('cluster/0') as DiscoverClusterVote | undefined
    const second = results.get('cluster/1') as DiscoverClusterVote | undefined
    if (first && second) {
      selection = consensusDiscoverClusters(selection, [first, second])
    } else if (completed) {
      throw new Error('Completed Discover root-cause review is incomplete')
    } else if (usesPostClusterLimit) {
      // The quota is applied after consensus; do not display provisional raw
      // candidates that may disappear or be replaced when both votes arrive.
      return {}
    }
  }
  if (usesPostClusterLimit && selection.selected.length > 0) {
    selection = limitDiscoverSelection(selection, config.maxCandidates)
  }
  const ranking = results.get('rank/final') as Ranking | undefined
  if (ranking?.ranking.some((item) => item.finding)) {
    const survivors = selection.selected.filter((finding) =>
      ['survives', 'contested'].includes(
        assessDiscoverVotes(
          config.lenses.map((lens) => results.get(`refute/${finding.id}/${lens}`))
        ).outcome
      )
    )
    const error = validateDiscoverReviewedRanking(ranking, survivors)
    if (error) {
      throw new Error(error)
    }
  }
  const reviewedById = new Map(
    ranking?.ranking.flatMap((item) =>
      item.finding ? [[item.findingId, item.finding] as const] : []
    ) ?? []
  )
  const assessedFindings = selection.selected.map((finding) => {
    const votes = config.lenses.map((lens) => results.get(`refute/${finding.id}/${lens}`))
    const assessment = assessDiscoverVotes(votes)
    const display = reviewedById.get(finding.id) ?? finding
    return {
      id: finding.id,
      label: display.title,
      disposition: assessment.disposition,
      markdown: `Severity: ${display.severity}\n\nLocation: ${display.location}\n\nTrigger: ${display.trigger}\n\nImpact: ${display.impact}\n\nAssessment: ${assessment.assessmentBasis}`,
      sources: display.evidence,
      verdicts: config.lenses.map((label, index) => {
        const vote = votes[index] as FindingVote | undefined
        return {
          label,
          verdict: !vote
            ? 'unresolved'
            : vote.uncertain
              ? 'uncertain'
              : vote.refuted
                ? 'refuted'
                : 'survives',
          markdown: vote?.reason ?? 'No accepted verdict is available.'
        }
      })
    }
  })
  // Retain every accepted finder candidate in the user-facing evidence ledger.
  // An excluded duplicate is still a separate observation with its own evidence;
  // only selected candidates receive skeptical verdicts and enter the ranking.
  const excludedBySource = new Map(
    selection.excluded.flatMap((entry) =>
      entry.source ? [[sourceKey(entry.source), entry] as const] : []
    )
  )
  const filteredFindings = (batches as FindingBatch[]).flatMap((batch, dimension) =>
    batch.findings.flatMap((finding, index) => {
      const source = {
        dimension: config.dimensions[dimension],
        index,
        producer: snapshot.seats[0].id
      }
      const exclusion = excludedBySource.get(sourceKey(source))
      if (!exclusion) {
        return []
      }
      const disposition =
        exclusion.reason === 'below-threshold'
          ? 'below threshold'
          : exclusion.reason === 'over-limit'
            ? 'over candidate limit'
            : 'duplicate'
      return [
        {
          id: `filtered-${dimension}-${index}`,
          label: finding.title,
          disposition,
          markdown: [
            `Finder dimension: ${source.dimension}; result ${index + 1}.`,
            `Excluded from skeptical assessment: ${disposition}${exclusion.reason === 'duplicate' ? ` of ${exclusion.findingId}` : ''}.`,
            `Severity: ${finding.severity}`,
            `Location: ${finding.location}`,
            `Trigger: ${finding.trigger}`,
            `Impact: ${finding.impact}`
          ].join('\n\n'),
          sources: finding.evidence,
          verdicts: []
        }
      ]
    })
  )
  const findings = [...assessedFindings, ...filteredFindings]
  if (findings.length !== selection.found) {
    throw new Error('Discover candidate ledger is incomplete')
  }
  const discoverCounts = {
    found: selection.found,
    duplicates: filteredFindings.filter((finding) => finding.disposition === 'duplicate').length,
    belowThreshold: filteredFindings.filter((finding) => finding.disposition === 'below threshold')
      .length,
    overLimit: filteredFindings.filter((finding) => finding.disposition === 'over candidate limit')
      .length,
    omittedByFinder: selection.omitted,
    assessed: assessedFindings.length,
    verdictsCompleted: config.lenses.reduce(
      (count, lens) =>
        count +
        selection.selected.filter((finding) => results.has(`refute/${finding.id}/${lens}`)).length,
      0
    ),
    verdictsTotal: assessedFindings.length * config.lenses.length,
    survivors: assessedFindings.filter((finding) =>
      ['survives', 'contested'].includes(finding.disposition)
    ).length,
    refuted: assessedFindings.filter((finding) => finding.disposition === 'refuted').length,
    notVerified: assessedFindings.filter(
      (finding) => finding.disposition === 'insufficient-evidence'
    ).length,
    unresolved: assessedFindings.filter((finding) => finding.disposition === 'unresolved').length
  }
  if (!completed) {
    return { findings, discoverCounts }
  }
  if (
    assessedFindings.some((finding) => finding.disposition === 'unresolved') ||
    (!ranking &&
      assessedFindings.some((finding) => ['survives', 'contested'].includes(finding.disposition)))
  ) {
    throw new Error('Completed Discover evidence is incomplete')
  }
  const markdown = ranking
    ? [
        ranking.summary,
        ...ranking.ranking.map((item, index) => {
          const finding = assessedFindings.find((entry) => entry.id === item.findingId)
          if (!finding) {
            throw new Error('Ranking references an unavailable finding')
          }
          return `${index + 1}. ${finding.label} (${finding.disposition})\n\n${item.reason}\n\nNext action: ${item.nextAction}`
        })
      ].join('\n\n')
    : !selection.found
      ? 'No findings in the inspected scope.'
      : !selection.selected.length
        ? 'No candidates met the selected threshold.'
        : 'No findings survived both-lens assessment.'
  return {
    findings,
    discoverCounts,
    result: {
      markdown,
      sources: snapshot.host.sources,
      coverage: [
        ...snapshot.host.coverage,
        `Found: ${selection.found}; selected: ${selection.selected.length}; omitted by finder: ${selection.omitted}; excluded: ${selection.excluded.length}.`,
        ...assessedFindings.map((finding) => `${finding.label}: ${finding.disposition}`)
      ]
    }
  }
}

export function workflowCallSeatId(
  snapshot: LocalWorkflowHostSnapshot,
  callId: string
): string | undefined {
  if (snapshot.discoverProgramRevision === DISCOVER_REVISION) {
    return discoverV7CallSeatId(snapshot, callId)
  }
  if (callId === 'synthesis/final' || callId === 'rank/final' || callId === 'chair/final') {
    return snapshot.synthesizerId
  }
  if (callId === 'cluster/0') {
    return snapshot.seats[0]?.id
  }
  if (callId === 'cluster/1') {
    return snapshot.seats[2]?.id
  }
  if (callId.startsWith('discover/')) {
    return snapshot.seats[0]?.id
  }
  if (callId.startsWith('refute/')) {
    const lens = callId.split('/').slice(2).join('/')
    const index = snapshot.discover?.lenses.indexOf(lens) ?? -1
    return index < 0 ? undefined : snapshot.seats[index + 1]?.id
  }
  return callId.split('/')[1]
}

function projectAnyDiscoverRun(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>,
  calls: readonly LocalWorkflowCallView[]
): LocalWorkflowDiscoverRun | undefined {
  if (snapshot.discoverProgramRevision === DISCOVER_REVISION) {
    return projectDiscoverV7Run(snapshot, results, calls)
  }
  let evidence: Pick<LocalWorkflowView, 'findings'> | undefined
  try {
    evidence = projectDiscoverEvidence(snapshot, results, false)
  } catch {
    evidence = undefined
  }
  return projectLegacyDiscoverRun(snapshot, results, calls, evidence)
}

/**
 * Revision-independent Discover view; legacy revisions map best-effort and never throw. `finished`
 * (completed, cancelled, failed or awaiting recovery) settles votes that will never land.
 */
export function projectDiscoverRun(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>,
  calls: readonly LocalWorkflowCallView[],
  finished = false
): LocalWorkflowDiscoverRun | undefined {
  const run = projectAnyDiscoverRun(snapshot, results, calls)
  return run && finished ? settleFinishedDiscoverRun(run) : run
}

/**
 * Final report markdown for Save/Copy (revision 7). Legacy revisions publish their result through
 * projectDiscoverEvidence instead.
 */
export function discoverResultMarkdown(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>
): string | undefined {
  return snapshot.discoverProgramRevision === DISCOVER_REVISION
    ? discoverV7ResultMarkdown(snapshot, results)
    : undefined
}
