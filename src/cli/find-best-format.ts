import type { LocalWorkflowFindStarted } from '../shared/local-workflow-find-request'
import type { LocalWorkflowView } from '../shared/local-workflow-view'

/** One line on where a Find the best run stands, for the terminal while it runs. */
export function findFollowLine(view: LocalWorkflowView): string {
  if (view.state === 'paused' || view.state === 'pausing') {
    return 'Paused in the app; following until it is resumed or stopped.'
  }
  const trail = view.graphRun?.find
  if (!trail) {
    return view.state === 'running' ? 'Starting…' : `Run ${view.state}.`
  }
  const noun = trail.source === 'versions' ? 'versions' : 'options'
  switch (trail.stage) {
    case 'options':
      return trail.source === 'versions' ? 'Writing complete versions…' : 'Coming up with options…'
    case 'check':
      return `Your check runs on ${trail.pool} versions…`
    case 'facts':
      return `Fetching GitHub facts for ${trail.facts?.repos ?? trail.pool} repositories…`
    case 'screen':
      return `JEV is scoring ${trail.pool} ${noun}…`
    case 'final':
      return `The top ${trail.overall.length} meet head to head…`
    case 'done':
      return `Best of ${trail.pool}: ${trail.winner?.title ?? ''}`
    case 'failed':
      return trail.reason ?? 'Find the best stopped.'
  }
}

/** Where the results files went, or why they were not written; nothing for a run without them. */
function savedLines(view: LocalWorkflowView): string[] {
  const saved = view.graphRun?.find?.saved
  if (!saved) {
    return []
  }
  if ('error' in saved) {
    return [`The results files were not saved: ${saved.error}`]
  }
  return saved.files.map((file, index) => `${index === 0 ? 'Saved:' : '      '} ${file}`)
}

/** The finished run as a person reads it: the report, then where every option and score is. */
export function findResultText(view: LocalWorkflowView): string {
  return [view.result?.markdown.trim() ?? '', savedLines(view).join('\n')]
    .filter(Boolean)
    .join('\n\n')
}

/** The finished run for a program: the address, the report, the saved files and every option. */
export function findResultJson(view: LocalWorkflowView, started: LocalWorkflowFindStarted) {
  const trail = view.graphRun?.find
  return {
    ...started,
    state: view.state,
    ...(view.error ? { error: view.error } : {}),
    ...(trail?.reason ? { reason: trail.reason } : {}),
    ...(view.result ? { report: view.result.markdown } : {}),
    ...(trail?.saved ? { saved: trail.saved } : {}),
    ...(trail?.winner ? { winner: trail.winner } : {}),
    ...(trail?.criteria ? { criteria: trail.criteria } : {}),
    ...(trail?.rows ? { rows: trail.rows } : {})
  }
}
