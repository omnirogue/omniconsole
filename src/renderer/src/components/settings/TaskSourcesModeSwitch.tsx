import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { TaskSourcesMode } from '../../../../shared/task-providers-mode'

type TaskSourcesModeSwitchProps = {
  mode: TaskSourcesMode
  onChange: (mode: TaskSourcesMode) => void
}

/* OmniConsole-only control: the single place a person turns the upstream task
 * providers on or off. Nothing is deleted either way — 'all' restores the exact
 * provider visibility that was saved before. */
export function TaskSourcesModeSwitch({
  mode,
  onChange
}: TaskSourcesModeSwitchProps): React.JSX.Element {
  const consoleOnly = mode === 'console-only'

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {consoleOnly
          ? translate(
              'auto.components.settings.TaskSourcesModeSwitch.consoleOnlyTitle',
              'Only the OmniConsole task source is shown'
            )
          : translate(
              'auto.components.settings.TaskSourcesModeSwitch.allTitle',
              'Every task source is shown'
            )}
      </p>
      <p className="mt-1">
        {consoleOnly
          ? translate(
              'auto.components.settings.TaskSourcesModeSwitch.consoleOnlyBody',
              'Tasks, the sidebar shortcuts and the source pickers offer the OmniConsole backoffice only. Your other providers stay configured and come back exactly as they were.'
            )
          : translate(
              'auto.components.settings.TaskSourcesModeSwitch.allBody',
              'Tasks offers every provider you keep visible below.'
            )}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2.5 h-auto whitespace-normal py-1.5 text-left text-xs"
        data-testid="task-sources-mode-switch"
        onClick={() => onChange(consoleOnly ? 'all' : 'console-only')}
      >
        {consoleOnly
          ? translate(
              'auto.components.settings.TaskSourcesModeSwitch.showOthers',
              'Show other task sources — GitHub Issues, GitLab, Linear, Jira, Bitbucket, Azure DevOps, Gitea'
            )
          : translate(
              'auto.components.settings.TaskSourcesModeSwitch.showConsoleOnly',
              'Show only the OmniConsole task source'
            )}
      </Button>
    </div>
  )
}
