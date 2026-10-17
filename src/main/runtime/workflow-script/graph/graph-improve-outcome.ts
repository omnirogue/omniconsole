import { checkResult } from './graph-improve-check'
import { graphImproveFinalLine } from './graph-improve-final'
import { graphPlural, type GraphImproveRound, type GraphRunOutcome } from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/** Whether a step is one of an Improve loop's two steps. */
export function graphImproving(scope: GraphScope, stepId: string): boolean {
  const repeat = scope.config.spec.repeat
  return repeat?.until === 'plateau' && (repeat.do === stepId || repeat.review === stepId)
}

/**
 * What did not go to plan inside an Improve loop. A round that failed or could not be judged
 * never loses the best version, but it is named, and so is stopping while still improving.
 */
export function graphImproveGaps(scope: GraphScope): string[] {
  const repeat = scope.config.spec.repeat!
  const gaps: string[] = []
  const trail = scope.loop?.improve
  // A round whose judging did not count already says why, with the judge's reason in it.
  const explained = (round: number) =>
    trail?.rounds.some((entry) => entry.round === round && entry.reason)
  for (const id of [repeat.do, repeat.review]) {
    const title = scope.title(id)
    for (const run of scope.runs[id] ?? []) {
      const where = `${title} (round ${run.round})`
      if (run.state === 'gaps') {
        gaps.push(`${where}: ${run.reason}`)
      }
      if (run.state === 'failed' && !(id === repeat.review && explained(run.round))) {
        gaps.push(`${where}: ${run.reason} The best version so far was kept.`)
      }
      if (run.cuts?.length) {
        gaps.push(`${where}: ${graphPlural(run.cuts.length, 'input')} cut to fit a prompt.`)
      }
    }
  }
  // A check that could not run at all is named, so judges-only rounds never pass for checked ones.
  // The final test is not a version: its own line below says when it could not run.
  const versionChecks = scope.calls.filter((call) => call.check && !call.check.sealed)
  const unavailable = versionChecks.flatMap((call) => {
    const outcome = scope.outcomes.get(call.id)
    const value =
      outcome && 'value' in outcome
        ? (outcome.value as { unavailable?: unknown; detail?: unknown })
        : undefined
    return outcome && (!value || value.unavailable === true)
      ? [typeof value?.detail === 'string' ? value.detail : 'The check could not run.']
      : []
  })
  if (unavailable.length) {
    gaps.push(
      `The check could not run on ${graphPlural(unavailable.length, 'version')}: ${unavailable[0]}`
    )
  }
  const partly = versionChecks.filter((call) => {
    const outcome = scope.outcomes.get(call.id)
    const value = outcome && 'value' in outcome ? checkResult(outcome) : undefined
    return !!value && !value.unavailable && !!value.cases?.unavailable
  }).length
  if (partly) {
    gaps.push(
      `Some practice cases could not run on ${graphPlural(partly, 'version')}; they count as not passed.`
    )
  }
  for (const entry of trail?.rounds ?? []) {
    if ((entry.result === 'unjudged' || entry.result === 'first') && entry.reason) {
      gaps.push(`Round ${entry.round}: ${entry.reason}`)
    }
  }
  const final = trail?.final
  if (final?.verdict && final.verdict !== 'held' && final.verdict !== 'same') {
    gaps.push(graphImproveFinalLine(final)!)
  }
  if (trail?.stop === 'max-rounds' && trail.rounds.at(-1)?.result === 'new-best') {
    gaps.push(
      `Still improving when the limit of ${graphPlural(repeat.maxRounds, 'round')} was reached; more rounds may help.`
    )
  }
  return gaps
}

function roundLine(entry: GraphImproveRound): string {
  const winner = entry.candidates.find((candidate) => candidate.accepted)
  // An unsure JEV that stood aside for the model judges decided nothing, so it is not named.
  const setAside = entry.jevUnsure && !entry.jevCounted && entry.judgedBy.includes('models')
  const deciders = entry.judgedBy.filter((who) => !(setAside && who === 'jev'))
  const by = deciders.length
    ? ` (decided by ${deciders.map((who) => (who === 'jev' ? 'JEV' : who === 'check' ? 'the check' : 'models')).join(' and ')}${entry.jevUnsure ? (setAside ? '; JEV was unsure, so it stood aside' : '; JEV was unsure') : ''})`
    : ''
  const kind = `${entry.mode === 'divergent' ? ' · fundamentally different approaches' : ''}${entry.escalated ? ' · frontier models' : ''}`
  const tried = graphPlural(
    entry.candidates.filter((candidate) => candidate.role !== 'best').length,
    'version'
  )
  switch (entry.result) {
    case 'first':
      return entry.reason
        ? `Round ${entry.round}${kind}: ${tried}; not judged, ${entry.jevUnsure ? "JEV's closer pick" : 'the first that came back'} became the best.`
        : `Round ${entry.round}${kind}: ${tried}; ${winner?.name ?? entry.candidates[0]?.name ?? 'one'} became the best${by}.`
    case 'new-best':
      return `Round ${entry.round}${kind}: ${tried}; ${winner?.name}'s beat the best version${by}${entry.noGain ? ', with no better test result' : ''}.`
    case 'kept':
      return `Round ${entry.round}${kind}: ${tried}; none beat the best version${by}.`
    case 'unjudged':
      return `Round ${entry.round}${kind}: ${tried}; not judged, the best version stayed.`
    case 'failed':
    case 'pending':
      return `Round ${entry.round}${kind}: no version came back.`
  }
}

/** The result of a run whose final step is the Improve loop: the best version found and how. */
export function graphImproveResult(scope: GraphScope, gaps: string[]): GraphRunOutcome {
  const repeat = scope.config.spec.repeat!
  const trail = scope.loop?.improve
  const output = scope.outputs.get(repeat.do)
  const markdown = output?.status === 'ok' ? (output.run.texts?.[0]?.markdown ?? '') : ''
  if (!trail?.best || !markdown.trim()) {
    return {
      state: 'failed',
      error:
        output && 'reason' in output
          ? output.reason
          : `${scope.title(repeat.do)} produced no version to improve on.`,
      gaps
    }
  }
  const divergent = trail.rounds.some((entry) => entry.mode === 'divergent')
  const stop =
    trail.stop === 'verified'
      ? 'Stopped: the best version passes the check.'
      : trail.stop === 'passing-kept'
        ? 'Stopped: every practice case passes, and the judges preferred the best version to each new change.'
        : trail.stop === 'plateau'
          ? `Stopped: ${graphPlural(trail.patience, 'round')} in a row brought no ${trail.measured ? 'better test result' : 'improvement'}${divergent ? ', and fundamentally different approaches did not help either' : ''}.`
          : trail.stop === 'max-rounds'
            ? `Stopped at the limit of ${graphPlural(repeat.maxRounds, 'round')}.`
            : trail.stop === 'undecided'
              ? 'Stopped: two rounds in a row could not be judged.'
              : 'Stopped early; the best version found so far is kept.'
  const found =
    trail.best.round === 0
      ? 'No version beat your code as it is, so the result is to leave it unchanged.'
      : `The best version is ${trail.best.name}'s from round ${trail.best.round}.`
  const verdict = graphImproveFinalLine(trail.final)
  const story = [
    ...(verdict ? [`**${verdict}**`] : []),
    `**How this was found.** ${found}`,
    ...trail.rounds.map((entry) => `- ${roundLine(entry)}`),
    stop
  ].join('\n')
  return {
    state: 'completed',
    gaps,
    final: { stepId: repeat.review, markdown: `${markdown}\n\n---\n\n${story}` }
  }
}
