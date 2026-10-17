import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'

/**
 * The kill switch for "Archive = pause" (archive-sleeps-idle-agents.ts); on by default, and inert
 * while restoreFloodGuard is off (it is on by default).
 */
export function ArchiveSleepsIdleAgentsSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate(
    'auto.components.settings.TerminalInteractionSection.archiveSleeps.title',
    'Archive puts idle agents to sleep'
  )
  return (
    <SearchableSetting
      title={title}
      description={translate(
        'auto.components.settings.TerminalInteractionSection.archiveSleeps.description',
        'Archiving a conversation stops its idle agent; opening it resumes. Archives by the CLI, agents or sync wait 30 idle minutes out of view.'
      )}
      keywords={['archive', 'sleep', 'pause', 'idle', 'agent', 'stop']}
    >
      <SettingsSwitchRow
        label={title}
        description={translate(
          'auto.components.settings.TerminalInteractionSection.archiveSleeps.switchDescription',
          'Never an agent on screen, used in the last 10 minutes, asking you something, or on another computer.'
        )}
        checked={settings.archiveSleepsIdleAgents !== false}
        onChange={() =>
          updateSettings({ archiveSleepsIdleAgents: settings.archiveSleepsIdleAgents === false })
        }
      />
    </SearchableSetting>
  )
}
