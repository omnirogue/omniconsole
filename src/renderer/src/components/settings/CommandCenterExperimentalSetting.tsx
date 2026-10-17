import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getCommandCenterExperimentalSearchEntry } from './command-center-experimental-search-entry'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

export function CommandCenterExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getCommandCenterExperimentalSearchEntry()
  const enabled = settings.commandCenter === true
  return (
    <SearchableSetting {...entry} id="experimental-command-center">
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSwitch
            checked={enabled}
            ariaLabel={entry.title}
            onChange={() => updateSettings({ commandCenter: !enabled })}
          />
        }
      />
    </SearchableSetting>
  )
}
