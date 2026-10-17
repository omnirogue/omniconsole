import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getEffectiveIdleAutoCloseMinutes,
  getEffectiveIdleAutoCloseMode,
  isRestoreFloodGuardOn,
  MAX_IDLE_AUTO_CLOSE_MINUTES,
  MIN_IDLE_AUTO_CLOSE_MINUTES,
  type IdleAutoCloseMode
} from '../../../../shared/idle-auto-close-settings'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { NumberField, SettingsSegmentedControl } from './SettingsFormControls'

type IdleAutoCloseExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** The idle auto-close mode (Shadow / On / Off, where Off is the kill switch) and its window. */
export function IdleAutoCloseExperimentalSetting({
  settings,
  updateSettings
}: IdleAutoCloseExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().idleAutoClose
  const mode = getEffectiveIdleAutoCloseMode(settings.idleAutoCloseMode)
  const suffix = translate(
    'auto.components.settings.ExperimentalPane.idleAutoClose.minutesSuffix',
    'minutes'
  )

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-idle-auto-close"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate('auto.components.settings.ExperimentalPane.idleAutoClose.title', 'Idle auto-close')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.idleAutoClose.copy',
              'Puts done agents to sleep (they resume when their tab is opened), puts a background workspace that holds only idle shells to sleep (no tab is closed; opening the workspace restarts its shells with their output) and discards browser pages hidden that long (they reload when shown). Nothing on screen, touched in the last 10 minutes or waiting on your answer is ever touched. Shadow writes what each rule would do to the session action log and changes nothing, Agent sleep included; On also needs the restore flood guard. Off stops all of it, Agent sleep included.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl<IdleAutoCloseMode>
          value={mode}
          onChange={(next) => updateSettings({ idleAutoCloseMode: next })}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.idleAutoClose.modeAriaLabel',
            'Idle auto-close mode'
          )}
          size="sm"
          options={[
            {
              value: 'shadow',
              label: translate('auto.components.settings.ExperimentalPane.idleAutoClose.shadow', 'Shadow')
            },
            {
              value: 'on',
              label: translate('auto.components.settings.ExperimentalPane.idleAutoClose.on', 'On')
            },
            {
              value: 'off',
              label: translate('auto.components.settings.ExperimentalPane.idleAutoClose.off', 'Off')
            }
          ]}
        />
      </div>
      {mode === 'on' && !isRestoreFloodGuardOn(settings) ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ExperimentalPane.idleAutoClose.onNeedsGuard',
            'On acts only while the restore flood guard is on; until then it stays a shadow and logs why.'
          )}
        </p>
      ) : null}
      {mode !== 'off' ? (
        <NumberField
          label={translate(
            'auto.components.settings.ExperimentalPane.idleAutoClose.idleMinutesLabel',
            'Idle window'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.idleAutoClose.idleMinutesDescription',
            'Minutes a done agent, idle shell or hidden browser page must stay idle. With Agent sleep on, done agents wait for the longer of this and its own window.'
          )}
          value={getEffectiveIdleAutoCloseMinutes(settings.idleAutoCloseMinutes)}
          min={MIN_IDLE_AUTO_CLOSE_MINUTES}
          max={MAX_IDLE_AUTO_CLOSE_MINUTES}
          step={1}
          integer
          suffix={suffix}
          onChange={(minutes) => updateSettings({ idleAutoCloseMinutes: minutes })}
        />
      ) : null}
    </SearchableSetting>
  )
}
