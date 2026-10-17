import { ACP_STRUCTURED_AGENTS } from '../../../../shared/acp-agent-recipes'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { SettingsSwitch } from './SettingsFormControls'

export function AgentAcpPreferences(props: {
  settings: GlobalSettings
  updateSettings: (patch: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {translate(
          'components.settings.acp.description',
          'Use ACP for selected agents in Structured Chat. Each command is checked before launch.'
        )}
      </p>
      {ACP_STRUCTURED_AGENTS.map((agent) => (
        <div key={agent} className="flex items-center justify-between gap-4">
          <Label>
            {translate('components.settings.acp.label', 'Use ACP — {{agent}}', {
              agent: TUI_AGENT_DISPLAY_NAMES[agent]
            })}
          </Label>
          <SettingsSwitch
            checked={props.settings.agentUseAcp?.[agent] === true}
            ariaLabel={translate('components.settings.acp.label', 'Use ACP — {{agent}}', {
              agent: TUI_AGENT_DISPLAY_NAMES[agent]
            })}
            onChange={() =>
              props.updateSettings({
                agentUseAcp: {
                  ...props.settings.agentUseAcp,
                  [agent]: props.settings.agentUseAcp?.[agent] !== true
                }
              })
            }
          />
        </div>
      ))}
    </div>
  )
}
