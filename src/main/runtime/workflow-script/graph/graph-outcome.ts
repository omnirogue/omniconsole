import { graphQuickDiscoverOutcome } from './graph-quick-discover-outcome'
import {
  councilFinalCheckIsGap,
  councilFinalCheckNote
} from '../../../../shared/workflow-council-final-check'
import {
  DECIDE_FALLBACK_SKEPTIC_ROUND,
  DECIDE_SKEPTIC_ROUND
} from '../../../../shared/workflow-decide-guard'
import { oneAnswerNote } from '../../../../shared/workflow-one-answer'
import type { WorkflowSpec, WorkflowStep } from '../../../../shared/workflow-graph'
import { workflowTopology } from '../../../../shared/workflow-graph-topology'
import { formatGraphItem } from './graph-items'
import type { GraphTally } from './graph-parse'
import {
  graphPlural,
  graphUnfinishedSearch,
  type GraphRunOutcome,
  type GraphStepRun
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { graphFindOutcome } from './graph-find-outcome'
import { graphOneAnswerOutcome } from './graph-one-answer'
import { graphImproveGaps, graphImproveResult, graphImproving } from './graph-improve-outcome'
import { graphJevVerdictNote } from './graph-report-evidence'
import {
  graphReportRanking,
  graphRankingWinners,
  graphRankingDocument
} from './graph-report-ranking'
import { graphClaimTable } from './graph-claim-table'
import { graphDiscoverReportFallback } from './graph-discover-report-fallback'

/**
 * How a settled run ends. It completes only when its final step produced a result; every step
 * that degraded or failed on the way is listed as a gap above that result.
 */
export function graphOutcome(scope: GraphScope): GraphRunOutcome {
  if (scope.route?.route === 'one-answer') {
    return graphOneAnswerOutcome(scope)
  }
  if (scope.find) {
    return graphFindOutcome(scope)
  }
  const { spec } = scope.config
  const { sinks } = workflowTopology(spec)
  const final = sinks.length === 1 ? scope.byId.get(sinks[0]) : undefined
  const failed = spec.steps
    .map((step) => ({ step, output: scope.outputs.get(step.id) }))
    .filter((entry) => entry.output?.status === 'failed')
  const gaps: string[] = []
  if (scope.route?.reason === 'unavailable') {
    gaps.push(oneAnswerNote(scope.route))
  }
  for (const step of spec.steps) {
    if (graphImproving(scope, step.id)) {
      continue
    }
    const runs = scope.runs[step.id]
    const output = scope.outputs.get(step.id)
    for (const run of runs) {
      // Decide's skeptic reports through the guard's note, never as a round of its own.
      if (skepticRound(spec, step.id, run.round)) {
        continue
      }
      const where = `${step.title}${runs.length > 1 ? ` (round ${run.round})` : ''}`
      if (run.state === 'gaps') {
        gaps.push(`${where}: ${run.reason}`)
      }
      if (run.unranked) {
        gaps.push(`${where}: ${run.unranked}`)
      }
      // A round that failed inside a repeat: named whenever the output still stands, and one by
      // one when several failed, so no round's failure is folded into another's.
      const failedRounds = runs.filter((entry) => entry.state === 'failed').length
      if (run.state === 'failed' && (output?.status === 'ok' || failedRounds > 1)) {
        gaps.push(`${where}: ${run.reason}`)
      }
      if (run.setAside) {
        gaps.push(
          step.kind === 'review'
            ? `${where}: ${graphPlural(run.setAside, 'item')} over the limit of ${step.forEach?.limit} ${run.setAside === 1 ? 'was' : 'were'} not checked; ${overLimitFate(run, run.setAside)}.`
            : `${where}: ${graphPlural(run.setAside, 'item')} over the limit of ${step.forEach?.limit} ${run.setAside === 1 ? 'was' : 'were'} not worked on.`
        )
      }
      if (run.cuts?.length) {
        const shown = run.cuts.slice(0, 3).join(' ')
        const more =
          run.cuts.length > 3 ? ` The step's notes list the other ${run.cuts.length - 3}.` : ''
        gaps.push(
          `${where}: ${graphPlural(run.cuts.length, 'input')} cut to fit a prompt. ${shown}${more}`
        )
      }
      if (run.state === 'empty' && run.calls.some((view) => view.skipped)) {
        gaps.push(`${where}: ${run.reason}`)
      } else if (step.kind === 'rank' && run.state === 'empty') {
        gaps.push(`${where}: ${run.reason} The steps after it went on without a ranking.`)
      }
      if (step.kind === 'rank' && (run.state === 'done' || run.state === 'gaps') && !counted(run)) {
        gaps.push(`${where}: no vote counted (a vote for one's own answer never counts).`)
      }
    }
  }
  const loop = scope.loop
  if (loop?.status === 'max-rounds' && spec.repeat?.until === 'nothing-new') {
    gaps.push(graphUnfinishedSearch(scope.title(spec.repeat.do), loop.maxRounds))
  }
  if (loop?.status === 'not-approved') {
    gaps.push(`Not approved after ${graphPlural(loop.maxRounds, 'round')}.`)
  }
  if (
    loop?.status === 'failed' &&
    spec.repeat?.until === 'nothing-new' &&
    scope.outputs.get(spec.repeat.do)?.status === 'ok'
  ) {
    gaps.push(`The search stopped early in round ${loop.round}; what earlier rounds found is kept.`)
  }
  if (spec.repeat?.until === 'plateau') {
    gaps.push(...graphImproveGaps(scope))
    if (final && graphImproving(scope, final.id)) {
      return graphImproveResult(scope, gaps)
    }
  }
  if (
    spec.template === 'quick-discover' &&
    !spec.steps.some((step) => step.kind === 'synthesize')
  ) {
    return graphQuickDiscoverOutcome(scope, gaps)
  }
  const finalOutput = final ? scope.outputs.get(final.id) : undefined
  const failure = (reason: string): GraphRunOutcome =>
    graphDiscoverReportFallback(scope, final, reason, gaps) ?? {
      state: 'failed',
      error: reason,
      gaps
    }
  if (!final || finalOutput?.status !== 'ok') {
    const reasons = failed.map((entry) =>
      entry.output?.status === 'failed' ? entry.output.reason : `${entry.step.title} failed.`
    )
    return failure(
      reasons.length
        ? reasons.join(' ')
        : final
          ? finalOutput && 'reason' in finalOutput
            ? finalOutput.reason
            : `${final.title} did not run.`
          : 'The workflow has no single final step.'
    )
  }
  for (const entry of failed) {
    if (entry.output?.status === 'failed') {
      gaps.push(`${entry.output.reason} The steps after it went on without it.`)
    }
  }
  // No run completes without a result: a final step with nothing to do, or nothing to show,
  // fails the run and says why.
  if (final.kind === 'rank' && finalOutput.run.state !== 'empty' && !counted(finalOutput.run)) {
    return failure(`${final.title} counted no vote, so it names no winner.`)
  }
  const check = finalOutput.run.finalCheck
  if (check && councilFinalCheckIsGap(check)) {
    gaps.push(councilFinalCheckNote(check))
  }
  const ranked =
    final.kind === 'synthesize' && final.rankItems
      ? graphReportRanking(scope, final, graphFinalMarkdown(scope, final, finalOutput.run))
      : undefined
  const table =
    final.kind === 'synthesize' && final.claimTable
      ? graphClaimTable(
          scope,
          final,
          ranked?.markdown ?? graphFinalMarkdown(scope, final, finalOutput.run)
        )
      : undefined
  const markdown =
    table?.markdown ?? ranked?.markdown ?? graphFinalMarkdown(scope, final, finalOutput.run)
  for (const gap of [ranked?.gap, table?.gap]) {
    if (gap) {
      gaps.push(gap)
    }
  }
  const tie = final.kind === 'rank' ? graphRankingWinners(finalOutput.run) : []
  if (tie.length > 1) {
    gaps.push(
      `${final.title}: tied for first between ${tie.map((entry) => entry.name).join(' and ')}.`
    )
  }
  if (finalOutput.run.state === 'empty' || !markdown.trim()) {
    return failure(
      `${final.title} produced no result${finalOutput.run.reason ? `: ${finalOutput.run.reason}` : '.'}`
    )
  }
  return {
    state: 'completed',
    gaps,
    final: {
      stepId: final.id,
      markdown,
      ...(ranked?.ranking ? { ranking: ranked.ranking } : {}),
      ...(table?.rows ? { claims: table.rows } : {}),
      ...(table?.appendix ? { appendix: table.appendix } : {})
    }
  }
}

const skepticRound = (spec: WorkflowSpec, stepId: string, round: number) =>
  !!spec.finalCheck?.skeptic &&
  spec.finalCheck.rank === stepId &&
  (round === DECIDE_SKEPTIC_ROUND || round === DECIDE_FALLBACK_SKEPTIC_ROUND)

/** Where a review's over-limit items ended up: unverified, unless live JEV verify decided them. */
function overLimitFate(run: GraphStepRun, count: number): string {
  // Results the pre-verify dropped are unchecked too, but not over the limit (`setAside`).
  const byJev = (run.targets ?? []).filter(
    (target) =>
      target.unchecked &&
      !target.screened &&
      !target.item.evidence?.preVerify?.dropped &&
      (target.confirmedBy || target.refutedBy)
  ).length
  const rest = count - byJev
  if (!byJev) {
    return `${count === 1 ? 'it is' : 'they are'} listed as unverified`
  }
  return rest > 0
    ? `JEV verify decided ${byJev}; the other ${rest} ${rest === 1 ? 'is' : 'are'} listed as unverified`
    : `JEV verify decided ${count === 1 ? 'it' : 'them'}`
}

/** A JEV verdict on its own line after the item, as the report evidence marks it. */
const jevLine = (target: Parameters<typeof graphJevVerdictNote>[0]) => {
  const note = graphJevVerdictNote(target)
  return note ? `\n_${note.slice(' · '.length)}_` : ''
}

function tallyGroups(run: GraphStepRun): string {
  const group = (tally: GraphTally, heading: string) => {
    const targets = (run.targets ?? []).filter((target) => target.tally === tally)
    return targets.length
      ? `## ${heading} (${targets.length})\n\n${targets.map((target, index) => `${index + 1}. ${formatGraphItem(target.item)}${jevLine(target)}`).join('\n\n')}`
      : ''
  }
  return [
    group('confirmed', 'Confirmed'),
    group('unverified', 'Unverified'),
    group('refuted', 'Refuted')
  ]
    .filter(Boolean)
    .join('\n\n')
}

const counted = (run: GraphStepRun) => (run.standings ?? []).some((standing) => standing.votes > 0)

/** The result document: what the final step produced, in the form a person reads. */
function graphFinalMarkdown(scope: GraphScope, step: WorkflowStep, run: GraphStepRun): string {
  if (step.kind === 'synthesize' || (step.kind === 'do' && (run.texts?.length ?? 0) === 1)) {
    const answer = run.finalCheckAnswer ?? run.texts?.[0]?.markdown ?? ''
    return run.finalCheck ? `${answer}\n\n${councilFinalCheckNote(run.finalCheck)}` : answer
  }
  if (step.kind === 'do') {
    return (run.texts ?? []).map((text) => `## ${text.name}\n\n${text.markdown}`).join('\n\n')
  }
  if (step.kind === 'rank') {
    return graphRankingDocument(run)
  }
  if (step.forEach) {
    return tallyGroups(run)
  }
  // A review ends the workflow: lead with the work it reviewed (a repeat's last draft, or what
  // its inputs produced), so the result is the deliverable and its verdicts, never verdicts alone.
  const { spec } = scope.config
  const inRepeat = spec.repeat?.review === step.id
  const work = (inRepeat ? [spec.repeat!.do] : step.inputs)
    .map((id) => ({ id, output: scope.outputs.get(id) }))
    .flatMap(({ id, output }) => {
      const kind = scope.byId.get(id)?.kind
      if (output?.status !== 'ok' || (kind !== 'do' && kind !== 'synthesize')) {
        return []
      }
      const { texts = [], items } = output.run
      if (items) {
        // A list read whole: the items are the work.
        return [
          `## ${scope.title(id)} (${graphPlural(items.length, 'item')})`,
          ...items.map((item, index) => `${index + 1}. ${formatGraphItem(item)}`)
        ]
      }
      return inRepeat || texts.length === 1
        ? texts.slice(0, 1).map((text) => text.markdown)
        : texts.map((text) => `## ${scope.title(id)}: ${text.name}\n\n${text.markdown}`)
    })
    .join('\n\n')
  const loop = scope.loop
  const status =
    loop && spec.repeat?.review === step.id
      ? loop.status === 'approved'
        ? `Approved in round ${loop.round}.`
        : `Not approved after ${graphPlural(loop.round, 'round')}.`
      : `${run.approved ? 'Approved' : 'Not approved'}: ${graphPlural((run.verdicts ?? []).filter((verdict) => verdict === 'pass').length, 'reviewer')} of ${step.agents.length} passed it, and approval needs every reviewer.`
  const reviews = (run.texts ?? [])
    .map(
      (text) =>
        `### ${scope.nameOf(text.seatId)}: ${(run.verdicts?.[text.agentIndex] ?? 'no verdict').toUpperCase()}\n\n${text.markdown}`
    )
    .join('\n\n')
  return [work, `**${status}**`, reviews].filter(Boolean).join('\n\n')
}
