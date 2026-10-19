import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type OmniSiPreviewsExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function OmniSiPreviewsExperimentalSetting({
  settings,
  updateSettings
}: OmniSiPreviewsExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().omniSiPreviews
  const enabled = settings.experimentalOmniSiPreviews === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-4 py-2"
      id="omnisi-previews"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.omniSiPreviews.toggleLabel',
            'Toggle OmniSI previews'
          )}
          onChange={() => updateSettings({ experimentalOmniSiPreviews: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
