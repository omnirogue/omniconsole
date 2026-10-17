import { translate } from '@/i18n/i18n'
import type { WorkflowRunsOn } from '../../../../shared/local-workflow-placement'

/** The setup control's label for a placement; translated at render time like the preset names. */
export function workflowRunsOnLabel(runsOn: WorkflowRunsOn): string {
  return runsOn === 'local'
    ? translate('workflowGraph.setup.runsOnLocal', 'Run on: this computer')
    : translate('workflowGraph.setup.runsOnFleet', 'Run on: fleet (default)')
}
