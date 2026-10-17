import type Database from '../../sqlite/sync-database'
import { discoverActedOnKeys } from '../../../shared/discover-omnios-decisions'
import { workflowRunResult } from '../../../shared/workflow-run-result'
import { readDiscoverDecisions } from './discover-omnios-decisions-read'
import { projectLocalWorkflow } from './local-workflow-projection'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowEarlierSettledReader } from './workflow-earlier-findings'

/** An earlier run's targets as its run result reports them, and the findings its page's answer acted on. */
export function workflowEarlierSettledReader(
  db: Database.Database,
  store: WorkflowCheckpointStore,
  pageRoot: string
): WorkflowEarlierSettledReader {
  return (executionId) => {
    const view = projectLocalWorkflow({ db, store, executionId, active: false })
    if (view.state !== 'completed' || !view.graphRun) {
      return undefined
    }
    const { targets } = workflowRunResult(
      view,
      { executionId, worktreeId: '', conversationId: '' },
      view.graphRun.spec.template,
      0
    ).results
    return { targets, actedOn: discoverActedOnKeys(readDiscoverDecisions(pageRoot, executionId)) }
  }
}
