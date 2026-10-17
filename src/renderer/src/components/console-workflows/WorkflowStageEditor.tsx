import { Button } from '@/components/ui/button'
import { WorkflowTextField, WorkflowSelect, WorkflowValue } from './WorkflowFields'
import { translate } from '@/i18n/i18n'
import type { WorkflowDraftStage } from '@/lib/console-workflow-draft'
import type { ConsoleWorkflowInventory } from '../../../../shared/console-workflow-types'
import { BuildReviewAgentFields } from '@/components/build-review/BuildReviewAgentFields'
import { useAppStore } from '@/store'
import { WorkflowAcceptanceFields } from './WorkflowAcceptanceFields'

export function WorkflowStageEditor({
  stage,
  stages,
  inventory,
  disabled,
  onChange,
  onRemove
}: {
  stage: WorkflowDraftStage
  stages: WorkflowDraftStage[]
  inventory: ConsoleWorkflowInventory | null
  disabled: boolean
  onChange: (stage: WorkflowDraftStage) => void
  onRemove: () => void
}) {
  const update = (patch: Partial<WorkflowDraftStage>) => onChange({ ...stage, ...patch })
  const worktree = useAppStore((state) => state.activeWorktreeId ?? '')
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-md border border-border p-4">
      <legend className="px-1 font-mono text-xs text-muted-foreground">{stage.key}</legend>
      <WorkflowTextField
        label={translate('consoleWorkflows.stageTitle', 'Stage title')}
        value={stage.title}
        onChange={(title) => update({ title })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkflowSelect
          label={translate('consoleWorkflows.actor', 'Actor')}
          value={stage.actorType}
          onChange={(actorType) =>
            update({ actorType: actorType as WorkflowDraftStage['actorType'] })
          }
          options={['ai', 'human', 'mechanical'].map((value) => ({ value, label: value }))}
        />
        <WorkflowSelect
          label={translate('consoleWorkflows.action', 'Action')}
          value={stage.action}
          onChange={(action) => update({ action: action as WorkflowDraftStage['action'] })}
          options={['execute', 'review', 'approve', 'decide', 'check', 'notify'].map((value) => ({
            value,
            label: value
          }))}
        />
      </div>
      {stage.actorType === 'ai' ? (
        <BuildReviewAgentFields
          usableOnly={false}
          role={`workflow-${stage.key}`}
          label={translate('consoleWorkflows.executionAgent', 'Execution agent')}
          worktree={worktree}
          agents={['claude', 'codex', 'grok']}
          helpText="Choose the agent, model and effort. The server confirms its supported route in the preview."
          defaultLabel="Server default"
          choice={{
            agent: stage.provider,
            ...(stage.model ? { model: stage.model } : {}),
            ...(stage.effort ? { effort: stage.effort } : {})
          }}
          onChange={(choice) =>
            update({
              provider: choice.agent,
              model: choice.model ?? '',
              effort: choice.effort ?? ''
            })
          }
        />
      ) : stage.actorType === 'human' ? (
        inventory ? (
          <WorkflowSelect
            label={translate('consoleWorkflows.assignedPerson', 'Assigned person')}
            value={stage.actorId}
            onChange={(actorId) => update({ actorId })}
            options={(inventory?.people ?? []).map((person) => ({
              value: person.id,
              label: person.name
            }))}
          />
        ) : (
          <WorkflowTextField
            label={translate('consoleWorkflows.assignedEmployeeId', 'Assigned employee ID')}
            value={stage.actorId}
            onChange={(actorId) => update({ actorId })}
          />
        )
      ) : (
        <WorkflowTextField
          label={translate('consoleWorkflows.mechanicalActor', 'Mechanical actor ID')}
          value={stage.actorId}
          onChange={(actorId) => update({ actorId })}
        />
      )}
      <WorkflowTextField
        label={translate('consoleWorkflows.stagePrompt', 'Exact stage prompt')}
        value={stage.prompt}
        onChange={(prompt) => update({ prompt })}
        multiline
      />
      <details className="space-y-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {translate('consoleWorkflows.stageSettings', 'Inputs, acceptance and placement')}
        </summary>
        <dl>
          <WorkflowValue
            label={translate('consoleWorkflows.runsAfter', 'Runs after')}
            value={
              stages.find((item) => item.key === stage.after[0])?.title ||
              translate('consoleWorkflows.firstStage', 'First stage')
            }
          />
        </dl>
        <WorkflowTextField
          label={translate('consoleWorkflows.stageInputs', 'Input references (one per line)')}
          value={stage.inputs}
          onChange={(inputs) => update({ inputs })}
          multiline
        />
        <WorkflowTextField
          label={translate('consoleWorkflows.acceptance', 'Acceptance')}
          value={stage.acceptance}
          onChange={(acceptance) => update({ acceptance })}
          multiline
        />
        {stage.actorType === 'ai' && (
          <WorkflowAcceptanceFields
            commands={stage.acceptanceCommands}
            onChange={(acceptanceCommands) => update({ acceptanceCommands })}
          />
        )}
        {stage.actorType === 'ai' && (
          <WorkflowSelect
            label={translate('consoleWorkflows.stagePlacement', 'Stage placement')}
            value={stage.placement}
            onChange={(placement) =>
              update({ placement: placement as WorkflowDraftStage['placement'] })
            }
            options={[
              {
                value: 'inherit',
                label: translate('consoleWorkflows.inheritPlacement', 'Use workflow placement')
              },
              { value: 'local', label: translate('consoleWorkflows.local', 'Local') },
              { value: 'fleet', label: translate('consoleWorkflows.fleet', 'Fleet') }
            ]}
          />
        )}
      </details>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || stages.length === 1}
        onClick={onRemove}
      >
        {translate('consoleWorkflows.removeStage', 'Remove stage')}
      </Button>
    </fieldset>
  )
}
