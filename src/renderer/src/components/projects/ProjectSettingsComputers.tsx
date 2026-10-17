import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { withHostToggled, type ProjectHostMode } from './project-settings-draft'

/** Where the project's sessions should run; the chat's workers follow a named list in order. */
export function ProjectSettingsComputers({
  mode,
  hosts,
  onChange
}: {
  mode: ProjectHostMode
  hosts: readonly string[]
  onChange: (next: { hostMode: ProjectHostMode; hosts: string[] }) => void
}): React.JSX.Element {
  const name = useId()
  const sshLabels = useAppStore((state) => state.sshTargetLabels)
  const paired = useAppStore((state) => state.runtimeEnvironments)
  const known = [
    {
      id: 'local',
      label: translate('projects.settings.thisComputer', 'This computer')
    },
    ...[...sshLabels].map(([targetId, label]) => ({
      id: `ssh:${targetId}`,
      label
    })),
    ...paired.map((environment) => ({
      id: toRuntimeExecutionHostId(environment.id),
      label: environment.name
    }))
  ]
  const knownIds = new Set(known.map((host) => host.id))
  // Why: a computer picked elsewhere stays pickable here, named by its id.
  const listed = [
    ...known,
    ...hosts.filter((id) => !knownIds.has(id)).map((id) => ({ id, label: id }))
  ]
  const modes: { value: ProjectHostMode; label: string }[] = [
    {
      value: 'as-named',
      label: translate('projects.settings.hostsAsNamed', 'As named')
    },
    { value: 'auto', label: translate('projects.settings.hostsAuto', 'Auto') },
    {
      value: 'hosts',
      label: translate('projects.settings.hostsChosen', 'These computers')
    }
  ]
  return (
    <fieldset className="space-y-2" data-project-settings-computers="">
      <legend className="text-xs font-medium">
        {translate('projects.settings.computers', 'Computers')}
      </legend>
      <div className="flex flex-wrap gap-3">
        {modes.map((option) => (
          <label key={option.value} className="flex items-center gap-1.5 text-xs">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={mode === option.value}
              onChange={() => onChange({ hostMode: option.value, hosts: [...hosts] })}
              className="accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {mode === 'hosts' ? (
        <ul className="max-h-32 space-y-1 overflow-y-auto scrollbar-sleek">
          {listed.map((host) => (
            <li key={host.id}>
              <label className="flex min-w-0 items-center gap-2 px-1 py-0.5 text-xs">
                <Checkbox
                  checked={hosts.includes(host.id)}
                  onCheckedChange={() =>
                    onChange({
                      hostMode: mode,
                      hosts: withHostToggled(hosts, host.id)
                    })
                  }
                />
                <span className="min-w-0 truncate">{host.label}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {mode === 'hosts' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projects.settings.hostsOrder',
            'Workers the project chat starts go to the first computer here that can take them. Sessions you start yourself run where you start them.'
          )}
        </p>
      ) : null}
    </fieldset>
  )
}
