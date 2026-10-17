import type { WorkflowAdmissionDraft } from '@/lib/console-workflow-admission-draft'
import type { WorkflowDraftStage } from '@/lib/console-workflow-draft'
import { WorkflowSelect, WorkflowTextField } from './WorkflowFields'
import { translate } from '@/i18n/i18n'

export function WorkflowAdmissionFields({
  draft,
  stages,
  onChange
}: {
  draft: WorkflowAdmissionDraft
  stages: WorkflowDraftStage[]
  onChange: (draft: WorkflowAdmissionDraft) => void
}) {
  const update = (patch: Partial<WorkflowAdmissionDraft>) => onChange({ ...draft, ...patch })
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-medium">
        {translate('consoleWorkflows.taskAndObjective', 'Task and objective')}
      </legend>
      <p className="text-xs text-muted-foreground">
        {translate(
          'consoleWorkflows.taskAndObjectiveHelp',
          'Use the existing goal and organization. Each preview reads the task revision from the server. The selected stage adopts this task; other stages receive their own tasks under the objective.'
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkflowTextField
          label={translate('consoleWorkflows.goalId', 'Goal ID')}
          value={draft.goalId}
          onChange={(goalId) => update({ goalId })}
        />
        <WorkflowTextField
          label={translate('consoleWorkflows.orgUnitId', 'Organization unit ID')}
          value={draft.orgUnitId}
          onChange={(orgUnitId) => update({ orgUnitId })}
        />
        <WorkflowTextField
          label={translate('consoleWorkflows.currentAuthorityEpoch', 'Current authority epoch')}
          value={draft.authorityEpoch}
          onChange={(authorityEpoch) => update({ authorityEpoch })}
        />
        <WorkflowSelect
          label={translate('consoleWorkflows.adoptStage', 'Stage adopting this task')}
          value={draft.adoptStage}
          onChange={(adoptStage) => update({ adoptStage })}
          options={stages.map((stage) => ({ value: stage.key, label: stage.title || stage.key }))}
        />
      </div>
      <WorkflowTextField
        label={translate('consoleWorkflows.objectiveTitle', 'Objective title')}
        value={draft.title}
        onChange={(title) => update({ title })}
      />
      <WorkflowTextField
        label={translate('consoleWorkflows.desiredResult', 'Desired result')}
        value={draft.desiredResult}
        onChange={(desiredResult) => update({ desiredResult })}
        multiline
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkflowTextField
          label={translate(
            'consoleWorkflows.acceptancePolicyJson',
            'Acceptance policy (JSON object)'
          )}
          value={draft.acceptancePolicy}
          onChange={(acceptancePolicy) => update({ acceptancePolicy })}
          multiline
        />
        <WorkflowTextField
          label={translate(
            'consoleWorkflows.verificationPolicyJson',
            'Verification policy (JSON object)'
          )}
          value={draft.verificationPolicy}
          onChange={(verificationPolicy) => update({ verificationPolicy })}
          multiline
        />
      </div>
    </fieldset>
  )
}
