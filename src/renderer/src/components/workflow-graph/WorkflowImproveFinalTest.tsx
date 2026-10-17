import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  WorkflowImproveFinal,
  WorkflowImproveFinalSide
} from '../../../../shared/workflow-improve-trail'

const scoreText = (score: number | undefined) =>
  score === undefined
    ? translate('workflowGraph.trail.final.noScore', 'no score')
    : String(Number(score.toFixed(2)))

/** The final test in one sentence: running, or whether the gain held on cases no AI saw. */
export function workflowImproveFinalText(final: WorkflowImproveFinal): string {
  const kept = !final.cases
    ? translate('workflowGraph.trail.final.keptCommand', 'a command kept back')
    : final.cases === 1
      ? translate('workflowGraph.trail.final.keptOne', '1 case kept back')
      : translate('workflowGraph.trail.final.keptMany', '{{count}} cases kept back', {
          count: final.cases
        })
  const code = final.start === 'unchanged'
  const { best, started } = final
  if (!final.verdict) {
    return translate('workflowGraph.trail.final.running', 'Final test ({{kept}}): running…', {
      kept
    })
  }
  if (final.verdict === 'same') {
    return code
      ? translate(
          'workflowGraph.trail.final.sameCode',
          'Final test ({{kept}}): not needed, since the result is your code as it is.',
          { kept }
        )
      : translate(
          'workflowGraph.trail.final.sameText',
          "Final test ({{kept}}): not needed, since the result is still round 1's best version.",
          { kept }
        )
  }
  if (final.verdict === 'unavailable' || !best || !started) {
    return translate(
      'workflowGraph.trail.final.unavailable',
      'Final test ({{kept}}): it could not run in full, so whether the improvement holds is unknown.',
      { kept }
    )
  }
  const passed = (side: WorkflowImproveFinalSide) =>
    final.cases
      ? translate('workflowGraph.trail.final.passedCount', 'passed {{count}}', {
          count: side.passed
        })
      : side.passed
        ? translate('workflowGraph.trail.final.passed', 'passed')
        : translate('workflowGraph.trail.final.failed', 'failed')
  const scored =
    best.score !== started.score
      ? translate(
          'workflowGraph.trail.final.scored',
          ', and the new version scored {{best}} against {{started}}',
          { best: scoreText(best.score), started: scoreText(started.score) }
        )
      : ''
  const results =
    best.passed === started.passed
      ? translate('workflowGraph.trail.final.both', 'both {{passed}}{{scored}}', {
          passed: passed(best),
          scored
        })
      : translate(
          'workflowGraph.trail.final.each',
          'the new version {{best}}, {{start}} {{started}}',
          {
            best: passed(best),
            start: code
              ? translate('workflowGraph.trail.final.startCode', 'what you started with')
              : translate('workflowGraph.trail.final.startText', "round 1's best version"),
            started: passed(started)
          }
        )
  const verdict =
    final.verdict === 'held'
      ? translate('workflowGraph.trail.final.held', 'The improvement held.')
      : final.verdict === 'tied'
        ? translate(
            'workflowGraph.trail.final.tied',
            'It did no better on cases it never saw, so the gain may not carry over.'
          )
        : code
          ? translate('workflowGraph.trail.final.worseCode', 'Keep what you have.')
          : translate(
              'workflowGraph.trail.final.worseText',
              "Round 1's best version may be the better choice."
            )
  return translate(
    'workflowGraph.trail.final.line',
    'Final test ({{kept}}): {{results}}. {{verdict}}',
    {
      kept,
      results,
      verdict
    }
  )
}

/** Only a gain that held is shown as good; unknown is never shown as held. */
export function WorkflowImproveFinalTest({ final }: { final: WorkflowImproveFinal }) {
  return (
    <p
      className={cn(
        final.verdict === 'held'
          ? 'text-status-success'
          : final.verdict && final.verdict !== 'same'
            ? 'text-status-warning'
            : 'text-muted-foreground'
      )}
    >
      {workflowImproveFinalText(final)}
    </p>
  )
}
