import { Button } from '@/components/ui/button'
import {
  newWorkflowAcceptanceDraft,
  type WorkflowAcceptanceDraft
} from '@/lib/console-workflow-draft-acceptance'
import { WorkflowTextField } from './WorkflowFields'
import { translate } from '@/i18n/i18n'

export function WorkflowAcceptanceFields({
  commands,
  onChange
}: {
  commands: WorkflowAcceptanceDraft[]
  onChange: (commands: WorkflowAcceptanceDraft[]) => void
}) {
  const update = (id: string, patch: Partial<WorkflowAcceptanceDraft>) =>
    onChange(commands.map((command) => (command.id === id ? { ...command, ...patch } : command)))
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium">
        {translate('consoleWorkflows.acceptanceCommands', 'Acceptance commands')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'consoleWorkflows.acceptanceCommandsHelp',
          'Commands run with the exact arguments shown after approval. An empty list runs no acceptance commands.'
        )}
      </p>
      {commands.map((command, index) => (
        <fieldset key={command.id} className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-xs">
            {translate('consoleWorkflows.command', 'Command')} {index + 1}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <WorkflowTextField
              label={translate('consoleWorkflows.program', 'Program')}
              value={command.program}
              onChange={(program) => update(command.id, { program })}
            />
            <WorkflowTextField
              label={translate('consoleWorkflows.timeoutMs', 'Timeout (ms)')}
              value={command.timeout}
              onChange={(timeout) => update(command.id, { timeout })}
            />
          </div>
          <WorkflowTextField
            label={translate('consoleWorkflows.argumentsJsonArray', 'Arguments (JSON array)')}
            value={command.arguments}
            onChange={(args) => update(command.id, { arguments: args })}
            multiline
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(commands.filter((item) => item.id !== command.id))}
          >
            {translate('consoleWorkflows.removeCommand', 'Remove command')}
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={commands.length >= 32}
        onClick={() => onChange([...commands, newWorkflowAcceptanceDraft()])}
      >
        {translate('consoleWorkflows.addAcceptanceCommand', 'Add acceptance command')}
      </Button>
    </section>
  )
}
