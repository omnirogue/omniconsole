import { translate } from '@/i18n/i18n'
import type {
  WorkflowImproveCandidate,
  WorkflowImprovePrediction
} from '../../../../shared/workflow-improve-trail'

const SYMBOLS = { '>=': '≥', '<=': '≤', '>': '>', '<': '<' } as const

/** The prediction as the version wrote it: kept as code words, never translated. */
function predictedText(predicted: NonNullable<WorkflowImprovePrediction['predicted']>): string {
  return 'outcome' in predicted
    ? predicted.outcome === 'pass'
      ? 'PASS'
      : 'FAIL'
    : `SCORE ${SYMBOLS[predicted.op]} ${predicted.score}`
}

/** One version's prediction in plain words: kept or killed, and what was measured. */
export function workflowPredictionText(prediction: WorkflowImprovePrediction): string {
  const { predicted, measured } = prediction
  if (prediction.verdict === 'missing' || !predicted) {
    return translate('workflowGraph.trail.prediction.missing', 'Killed: it gave no prediction.')
  }
  const values = { predicted: predictedText(predicted) }
  if (prediction.verdict === 'untested') {
    return translate(
      'workflowGraph.trail.prediction.untested',
      'Kept: the test could not run, so its prediction ({{predicted}}) was not tested.',
      values
    )
  }
  const result =
    'score' in predicted
      ? measured?.score !== undefined
        ? translate('workflowGraph.trail.prediction.measured', 'measured {{score}}', {
            score: measured.score
          })
        : translate('workflowGraph.trail.prediction.noScore', 'it printed no score')
      : measured?.passed
        ? translate('workflowGraph.trail.prediction.passed', 'it passed')
        : translate('workflowGraph.trail.prediction.failed', 'it failed')
  return prediction.verdict === 'held'
    ? translate(
        'workflowGraph.trail.prediction.held',
        'Kept: prediction held (predicted {{predicted}}, {{result}}).',
        { ...values, result }
      )
    : translate(
        'workflowGraph.trail.prediction.missed',
        'Killed: predicted {{predicted}}, {{result}}.',
        {
          ...values,
          result
        }
      )
}

/** Under a round's versions: each version's prediction, and whether it was kept or killed. */
export function WorkflowImprovePredictionNotes({
  candidates,
  name
}: {
  candidates: readonly WorkflowImproveCandidate[]
  name: (candidate: WorkflowImproveCandidate) => string
}) {
  const predicting = candidates.filter((candidate) => candidate.prediction)
  if (!predicting.length) {
    return null
  }
  return (
    <ul className="space-y-0.5 text-muted-foreground">
      {predicting.map((candidate) => (
        <li
          key={candidate.label}
          className={
            candidate.prediction!.verdict === 'missed' ||
            candidate.prediction!.verdict === 'missing'
              ? 'text-status-warning'
              : undefined
          }
        >
          {name(candidate)}: {workflowPredictionText(candidate.prediction!)}
        </li>
      ))}
    </ul>
  )
}
