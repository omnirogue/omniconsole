import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import { workflowAnchorKind, workflowPresetRunsOn } from '../local-workflows/workflow-presets'
import {
  useWorkflowRunOnHosts,
  withWorkflowRunOnChoice,
  workflowRunOnOptions,
  workflowRunOnPick,
  workflowRunOnValue,
  type WorkflowRunOnChoice
} from '../local-workflows/workflow-run-on-hosts'
import { WorkflowSelect } from './workflow-graph-controls'

/** "Run on": the fleet's pick, this computer, or a fleet host by name. */
export function WorkflowRunOnPicker({
  choice,
  onChange,
  className
}: {
  choice: WorkflowRunOnChoice
  onChange: (choice: WorkflowRunOnChoice) => void
  className?: string
}) {
  const { hosts, targets } = useWorkflowRunOnHosts()
  return (
    <WorkflowSelect
      className={className}
      value={workflowRunOnValue(choice)}
      options={workflowRunOnOptions(hosts, choice)}
      onChange={(next) => onChange(workflowRunOnPick(next, hosts, targets))}
    />
  )
}

/**
 * Where the run executes: the fleet (the preset's default), this computer, or a named host.
 * A draft saved before the choice existed shows the preset's default, which is what the host runs.
 */
export function WorkflowRunsOnSelect({
  draft,
  onChange
}: {
  draft: LocalWorkflowDraft
  onChange: (draft: LocalWorkflowDraft) => void
}) {
  const kind = workflowAnchorKind({
    preset: draft.graph?.spec.template === 'discover' ? 'discover' : 'council',
    draft
  })
  return (
    <WorkflowRunOnPicker
      className="w-52"
      choice={{
        runsOn: draft.runsOn ?? workflowPresetRunsOn(kind),
        ...(draft.runsOnHost ? { runsOnHost: draft.runsOnHost } : {}),
        ...(draft.runsOnHostId ? { runsOnHostId: draft.runsOnHostId } : {})
      }}
      onChange={(choice) => onChange(withWorkflowRunOnChoice(draft, choice))}
    />
  )
}
