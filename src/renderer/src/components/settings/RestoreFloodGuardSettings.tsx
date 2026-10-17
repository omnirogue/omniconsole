import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { NumberField, SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type RestoreFloodGuardSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: kill switches for the 2026-09-30 restore-flood fix — resume-on-open with duplicate
// protection, and main's app-wide agent start window (3 per 10 seconds by default). Turning the
// guard off turns the window off too (the whole fix's kill switch); 0 turns off only the window.
export function RestoreFloodGuardSettings({
  settings,
  updateSettings
}: RestoreFloodGuardSettingsProps): React.JSX.Element {
  const guardTitle = translate(
    'auto.components.settings.TerminalInteractionSection.restoreFloodGuard.title',
    'Resume slept agents only when opened'
  )
  const admissionTitle = translate(
    'auto.components.settings.TerminalInteractionSection.launchAdmission.title',
    'Agent starts per 10 seconds'
  )
  const admissionDescription = translate(
    'auto.components.settings.TerminalInteractionSection.launchAdmission.description',
    'At most this many agents start in any 10 seconds; the rest wait their turn, and a tab you open goes first. 0 means no limit, as does turning off Resume slept agents only when opened.'
  )
  return (
    <>
      <SearchableSetting
        title={guardTitle}
        description={translate(
          'auto.components.settings.TerminalInteractionSection.restoreFloodGuard.description',
          'A finished, slept or archived agent resumes when you open its tab, never from a background mount. Agents that were mid-task still continue on their own, and no session is resumed as a second copy.'
        )}
        keywords={['restore', 'resume', 'flood', 'agent', 'duplicate']}
      >
        <SettingsSwitchRow
          label={guardTitle}
          description={translate(
            'auto.components.settings.TerminalInteractionSection.restoreFloodGuard.switchDescription',
            'Turn off to resume every restored agent as soon as its tab mounts, with no limit on agent starts.'
          )}
          checked={settings.restoreFloodGuard !== false}
          onChange={() =>
            updateSettings({ restoreFloodGuard: settings.restoreFloodGuard === false })
          }
        />
      </SearchableSetting>
      <SearchableSetting
        title={admissionTitle}
        description={admissionDescription}
        keywords={['agent', 'start', 'limit', 'queue', 'load']}
      >
        <NumberField
          label={admissionTitle}
          description={admissionDescription}
          value={settings.launchAdmissionPer10s ?? 3}
          defaultValue={3}
          min={0}
          max={50}
          step={1}
          integer
          onChange={(value) => updateSettings({ launchAdmissionPer10s: value })}
        />
      </SearchableSetting>
    </>
  )
}
