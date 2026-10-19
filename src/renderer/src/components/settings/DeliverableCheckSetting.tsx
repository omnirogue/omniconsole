import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DELIVERABLE_VERIFIER_MODES,
  DELIVERABLE_VERIFIER_REPAIRS_MAX,
  DELIVERABLE_VERIFIER_REPAIRS_MIN,
  normalizeDeliverableVerifierSettings,
  type DeliverableVerifierMode
} from '../../../../shared/deliverable-verifier-settings'
import { Label } from '../ui/label'
import {
  getDeliverableCheckDescription,
  getDeliverableCheckModeDetail,
  getDeliverableCheckModeLabel,
  getDeliverableCheckRepairsLabel,
  getDeliverableCheckSearchKeywords,
  getDeliverableCheckTitle
} from './deliverable-check-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'

const REPAIR_COUNTS = Array.from(
  { length: DELIVERABLE_VERIFIER_REPAIRS_MAX - DELIVERABLE_VERIFIER_REPAIRS_MIN + 1 },
  (_, index) => DELIVERABLE_VERIFIER_REPAIRS_MIN + index
)

/** Off, Watch only (the default) or Check and ask to finish, with the per-request repair count. */
export function DeliverableCheckSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const current = normalizeDeliverableVerifierSettings(settings.deliverableVerifier)
  const title = getDeliverableCheckTitle()
  const save = (next: { mode?: DeliverableVerifierMode; maxRepairs?: number }): void => {
    void updateSettings({ deliverableVerifier: { ...current, ...next } })
  }
  return (
    <section className="space-y-3">
      <SearchableSetting
        title={title}
        description={getDeliverableCheckDescription()}
        keywords={getDeliverableCheckSearchKeywords()}
      >
        <div className="space-y-3 py-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label>{title}</Label>
              <p className="text-xs text-muted-foreground">{getDeliverableCheckDescription()}</p>
            </div>
            <SettingsSegmentedControl
              value={current.mode}
              onChange={(mode) => save({ mode })}
              ariaLabel={title}
              size="sm"
              options={DELIVERABLE_VERIFIER_MODES.map((mode) => ({
                value: mode,
                label: getDeliverableCheckModeLabel(mode)
              }))}
            />
          </div>
          <p className="text-xs text-muted-foreground" data-deliverable-check-detail="">
            {getDeliverableCheckModeDetail(current.mode, current.maxRepairs)}
          </p>
          {current.mode === 'on' ? (
            <div className="flex items-center justify-between gap-4">
              <Label className="text-xs font-normal">{getDeliverableCheckRepairsLabel()}</Label>
              <SettingsSegmentedControl
                value={current.maxRepairs}
                onChange={(maxRepairs) => save({ maxRepairs })}
                ariaLabel={getDeliverableCheckRepairsLabel()}
                size="sm"
                options={REPAIR_COUNTS.map((count) => ({ value: count, label: String(count) }))}
              />
            </div>
          ) : null}
        </div>
      </SearchableSetting>
    </section>
  )
}
