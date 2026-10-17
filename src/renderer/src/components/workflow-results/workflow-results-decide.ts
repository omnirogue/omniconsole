import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowGraphRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import { criterionCandidatesStep } from '../../../../shared/workflow-graph-decide-fields'
import { workflowResultDocument } from '../../../../shared/workflow-graph-web'
import type {
  WorkflowDecideStatus,
  WorkflowResultCandidate,
  WorkflowResults
} from './workflow-results-candidates'

/** How far the shown decision was checked: "checked" means the guard and skeptic passed it with no gap. */
export function decideStatus(run: LocalWorkflowGraphRun): WorkflowDecideStatus {
  if (run.route?.route === 'one-answer') {
    return 'answer'
  }
  const chair = run.steps.find((step) => step.id === run.spec.finalCheck?.chair)
  const check = chair?.rounds[0]?.finalCheck
  const skeptic = check?.skeptic
  if (skeptic?.status === 'withheld') {
    return 'withheld'
  }
  if (
    !check ||
    !skeptic ||
    skeptic.status === 'unchecked' ||
    ['failed', 'finished-early', 'no-peer-votes'].includes(check.result)
  ) {
    return 'unchecked'
  }
  if (check.result === 'inconclusive') {
    return 'inconclusive'
  }
  // The guard and skeptic vouch only for the last step: an earlier gap still stands.
  return run.gaps.length ? 'warnings' : 'checked'
}

function decisionTitle(status: WorkflowDecideStatus): string {
  switch (status) {
    case 'checked':
      return translate('resultsLaunch.decide.checked', 'The recommendation (checked)')
    case 'warnings':
      return translate(
        'resultsLaunch.decide.warnings',
        'The recommendation (checked, with warnings)'
      )
    case 'inconclusive':
      return translate(
        'resultsLaunch.decide.inconclusive',
        'The recommendation (the guard was not decisive)'
      )
    case 'unchecked':
      return translate('resultsLaunch.decide.unchecked', 'The recommendation (not fully checked)')
    case 'withheld':
      return translate('resultsLaunch.decide.withheld', 'No recommendation passed the checks')
    case 'answer':
      return translate('resultsLaunch.decide.answer', "One model's answer")
  }
}

/**
 * Decide's results: what the run showed, titled with how far it was checked (a winner only when
 * it passed every check), then every developed finalist in the comparison's overall order. The
 * run's gaps travel with them as warnings, apart from any text that may be cut.
 */
export function decideResults(
  view: LocalWorkflowView,
  run: LocalWorkflowGraphRun
): WorkflowResults | undefined {
  const shipped = view.result && workflowResultDocument(view.result).trim()
  if (!shipped) {
    return undefined
  }
  const status = decideStatus(run)
  const answer: WorkflowResultCandidate = {
    id: `${view.executionId}:decision`,
    key: 'decision',
    title: decisionTitle(status),
    detail: shipped,
    decision: status,
    ...(status === 'checked' ? { winner: true as const } : {}),
    preselected: true
  }
  const byId = new Map(run.spec.steps.map((step) => [step.id, step]))
  const compare = run.spec.steps.find((step) => step.byCriterion)
  const source = compare && criterionCandidatesStep(compare, byId)
  const overall = run.steps
    .find((step) => step.id === compare?.id)
    ?.rounds.find((r) => r.round === 1)
  const developed = run.steps.find((step) => step.id === source?.id)?.rounds[0]?.labels ?? []
  const finalists = developed.flatMap(({ callId, label }) => {
    const title = label.replace(/ · Response [A-Z]+$/, '')
    const detail = view.calls.find((call) => call.id === callId)?.resultMarkdown?.trim()
    if (!detail) {
      return []
    }
    const place = overall?.standings?.find((row) => row.name === title && row.votes > 0)?.place
    const leads = (overall?.criteria ?? [])
      .filter((entry) => entry.leaders.includes(title))
      .map((entry) => entry.criterion)
    return [
      {
        id: `${view.executionId}:${callId}`,
        key: callId,
        title,
        detail,
        ...(place !== undefined ? { place } : {}),
        ...(leads.length ? { leads } : {}),
        preselected: false
      }
    ]
  })
  const byPlace = (entry: WorkflowResultCandidate) => entry.place ?? Number.MAX_SAFE_INTEGER
  return {
    kind: 'decide',
    candidates: [answer, ...finalists.toSorted((left, right) => byPlace(left) - byPlace(right))],
    ...(run.gaps.length ? { warnings: run.gaps } : {})
  }
}
