import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConsoleWorkflowPreview } from '../../../../shared/console-workflow-types'
import type { ConsoleTaskAdmissionContext } from '../../../../shared/console-workflow-task-types'
import { WorkflowGraph } from './WorkflowGraph'
import { WorkflowValue } from './WorkflowFields'

export function WorkflowPreviewPanel({
  preview,
  admission,
  taskId,
  revision,
  consent,
  onConsent,
  onApprove,
  pending
}: {
  preview: ConsoleWorkflowPreview
  admission?: ConsoleTaskAdmissionContext
  taskId?: string
  revision?: number
  consent: boolean
  onConsent: (checked: boolean) => void
  onApprove: () => void
  pending: boolean
}) {
  const [selectedKey, setSelectedKey] = useState(preview.graph.nodes[0]?.key ?? null)
  const node = preview.graph.nodes.find((item) => item.key === selectedKey)
  return (
    <section className="space-y-4 border-t border-border pt-4">
      <h2 className="text-sm font-medium">
        {translate('consoleWorkflows.serverPreview', 'Server preview')}
      </h2>
      {admission && (
        <dl className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2">
          <WorkflowValue
            label={translate('consoleWorkflows.existingTask', 'Existing task')}
            value={taskId}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.observedTaskRevision', 'Observed task revision')}
            value={revision}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.adoptedStage', 'Adopted stage')}
            value={admission.adoptStage}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.organizationUnit', 'Organization unit')}
            value={admission.orgUnitId}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.authorityEpoch', 'Authority epoch')}
            value={admission.expectedAuthorityEpoch}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.objectiveAndPolicies', 'Objective and policies')}
            value={admission.objective}
          />
        </dl>
      )}
      <WorkflowGraph
        nodes={preview.graph.nodes.map((item) => ({ ...item, actorType: item.actor_type }))}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
      />
      {node && (
        <dl className="space-y-3 rounded-md border border-border p-4">
          <WorkflowValue
            label={translate('consoleWorkflows.stagePrompt', 'Exact stage prompt')}
            value={node.brief}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.provider', 'Provider')}
            value={node.provider}
          />
          <WorkflowValue label={translate('consoleWorkflows.model', 'Model')} value={node.model} />
          <WorkflowValue
            label={translate('consoleWorkflows.effort', 'Effort')}
            value={node.effort}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.acceptance', 'Acceptance')}
            value={node.acceptance}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.repository', 'Repository')}
            value={node.repo}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.placement', 'Placement')}
            value={node.placement}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.acceptanceCommands', 'Acceptance commands')}
            value={node.acceptance_commands}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.ownedPaths', 'Owned paths')}
            value={node.owned_paths}
          />
        </dl>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {translate('consoleWorkflows.exactGraph', 'Exact server graph and inputs')}
        </summary>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words scrollbar-sleek font-mono text-xs">
          {JSON.stringify(preview.graph, null, 2)}
        </pre>
      </details>
      <dl>
        <WorkflowValue
          label={translate('consoleWorkflows.digest', 'Graph digest')}
          value={preview.digest}
        />
      </dl>
      <Label className="flex items-start gap-2">
        <Checkbox
          checked={consent}
          disabled={pending}
          onCheckedChange={(checked) => onConsent(checked === true)}
        />
        {translate(
          'consoleWorkflows.exactApproval',
          'I approve exactly this task adoption, objective, policies, graph, prompts, inputs, placement and acceptance commands.'
        )}
      </Label>
      <Button disabled={!consent || pending} onClick={onApprove}>
        {translate('consoleWorkflows.approveWorkflow', 'Approve workflow')}
      </Button>
    </section>
  )
}
