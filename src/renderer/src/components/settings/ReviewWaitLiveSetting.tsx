import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getEffectiveReviewWaitLiveMinutes,
  MAX_REVIEW_WAIT_LIVE_MINUTES,
  MIN_REVIEW_WAIT_LIVE_MINUTES
} from '../../../../shared/artifact-review-sleep'
import { translate } from '@/i18n/i18n'
import { NumberField } from './SettingsFormControls'

/** How long a session that asked for a review decision stays live before it sleeps. */
export function ReviewWaitLiveSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="py-4">
      <NumberField
        label={translate(
          'auto.components.settings.artifacts.reviewWaitLiveLabel',
          'Wait for a review decision'
        )}
        description={translate(
          'auto.components.settings.artifacts.reviewWaitLiveDescription',
          'After a session publishes a page for review, it stays running this long, then goes to sleep. A decision on the page wakes the same conversation; Reject deletes it with its own worktree and branch. Sleep happens only while Idle auto-close is On and this computer’s cleanup protections are set.'
        )}
        value={getEffectiveReviewWaitLiveMinutes(settings.reviewWaitLiveMinutes)}
        min={MIN_REVIEW_WAIT_LIVE_MINUTES}
        max={MAX_REVIEW_WAIT_LIVE_MINUTES}
        step={1}
        integer
        suffix={translate('auto.components.settings.artifacts.reviewWaitLiveSuffix', 'minutes')}
        onChange={(minutes) => void updateSettings({ reviewWaitLiveMinutes: minutes })}
      />
    </div>
  )
}
