import { Fragment, useRef, useState } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeSessionStewardSettings,
  SESSION_STEWARD_EMPTY_SESSION_MINUTES_DEFAULT,
  SESSION_STEWARD_EMPTY_SESSION_MINUTES_MAX,
  SESSION_STEWARD_EMPTY_SESSION_MINUTES_MIN,
  type SessionStewardEmptyAction,
  type SessionStewardFeature,
  type SessionStewardSettings
} from '../../../../shared/session-steward-settings'
import type { SessionStewardOrganizeSettings } from '../../../../shared/session-steward-organize-settings'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from './SettingsFormControls'

type StewardSwitch = Exclude<SessionStewardFeature, 'enabled'>

function switchRows(): { key: StewardSwitch; label: string; description: string }[] {
  return [
    {
      key: 'safeYes',
      label: translate('sessionSteward.safeYes', 'Say yes to safe next steps'),
      description: translate(
        'sessionSteward.safeYesHint',
        'Presses Yes on a step a session offers when it stays inside your original request. At most 3 a day per session, never on deploys, sends, money or ads.'
      )
    },
    {
      key: 'nudges',
      label: translate('sessionSteward.nudges', 'Nudge sessions that stopped with work left'),
      description: translate(
        'sessionSteward.nudgesHint',
        'One marked nudge per 12 hours; asks an unclear one whether it is done. Sessions driven by Keep going are never prompted.'
      )
    },
    {
      key: 'tier2Archive',
      label: translate('sessionSteward.tier2Archive', 'Archive finished sessions'),
      description: translate(
        'sessionSteward.tier2ArchiveClockHint',
        'Uses the Conversations clock menu delay (two hours by default). Keeps bells and unfinished work visible, with a result card and Undo.'
      )
    },
    {
      key: 'emptySessionArchive',
      label: translate('sessionSteward.emptySessionCleanup', 'Clean up sessions nobody prompted'),
      description: translate(
        'sessionSteward.emptySessionCleanupHint',
        'A blank session (its agent started, nobody typed or sent anything, and it is not on screen) is cleaned up after the minutes below: closed the way Delete closes it (its agent stops; Recently closed reopens it), or archived. One whose agent already exited goes at once. Unknown is always kept.'
      )
    },
    {
      key: 'automaticCleanup',
      label: translate('sessionSteward.automaticCleanup', 'Clean up when leftovers pile up'),
      description: translate(
        'sessionSteward.automaticCleanupHint',
        'Starts a short one-off cleanup session by itself: at most 3 a day, one at a time, only with spare capacity.'
      )
    },
    {
      key: 'sessionWaits',
      label: translate('sessionSteward.sessionWaits', 'Let sessions wait for another session'),
      description: translate(
        'sessionSteward.sessionWaitsHint',
        'A session can wait for another one’s result and is woken once when it is ready.'
      )
    },
    {
      key: 'tier1WaiterCheck',
      label: translate('sessionSteward.tier1WaiterCheck', 'Keep sessions others are waiting on'),
      description: translate(
        'sessionSteward.tier1WaiterCheckHint',
        'Automatic archive skips a session while another session waits for its result.'
      )
    }
  ]
}

type OrganizeSwitch = Exclude<
  keyof SessionStewardOrganizeSettings,
  'accuracyGuard' | 'pairReadsPerDay'
>

function organizeRows(): { key: OrganizeSwitch; label: string; description: string }[] {
  return [
    {
      key: 'refile',
      label: translate('sessionSteward.refile', 'Move sessions to better folders'),
      description: translate(
        'sessionSteward.refileHint',
        'Only idle sessions it filed itself or nobody filed, after the same answer twice a day apart. Never a session you placed. Pauses itself if you undo too many moves.'
      )
    },
    {
      key: 'retitle',
      label: translate('sessionSteward.retitle', 'Re-title sessions whose goal moved on'),
      description: translate(
        'sessionSteward.retitleHint',
        'Never a title you typed and never while a session is working. Pauses itself if you undo too many titles.'
      )
    },
    {
      key: 'mergeSuggestions',
      label: translate('sessionSteward.mergeSuggestions', 'Suggest merging duplicate sessions'),
      description: translate(
        'sessionSteward.mergeSuggestionsHint',
        'Shown in Work with Yes and Dismiss; nothing merges without your yes.'
      )
    },
    {
      key: 'projectSuggestions',
      label: translate(
        'sessionSteward.projectSuggestions',
        'Suggest turning busy batches into projects'
      ),
      description: translate(
        'sessionSteward.projectSuggestionsHint',
        'Shown in Work with Yes and Dismiss; a yes moves the batch into a Saved project folder.'
      )
    }
  ]
}

/** What the blank-session rule does, and after how long. */
function EmptySessionControls({
  config,
  write
}: {
  config: SessionStewardSettings
  write: (change: Partial<SessionStewardSettings>) => void
}): React.JSX.Element {
  const close = config.emptySessionAction === 'close'
  return (
    <>
      <SettingsRow
        label={translate('sessionSteward.emptySessionAction', 'What happens to a blank session')}
        description={
          close
            ? translate(
                'sessionSteward.emptySessionActionCloseHint',
                'Close: its tab closes and its agent stops, freeing its memory. Undo brings the row back; Recently closed reopens the tab.'
              )
            : translate(
                'sessionSteward.emptySessionActionArchiveHint',
                'Archive: the row moves under Archived and its agent keeps running. Undo or new activity brings it back.'
              )
        }
        control={
          <SettingsSegmentedControl<SessionStewardEmptyAction>
            ariaLabel={translate(
              'sessionSteward.emptySessionAction',
              'What happens to a blank session'
            )}
            value={config.emptySessionAction}
            onChange={(action) => write({ emptySessionAction: action })}
            options={[
              { value: 'close', label: translate('sessionSteward.emptySessionClose', 'Close') },
              {
                value: 'archive',
                label: translate('sessionSteward.emptySessionArchiveAction', 'Archive')
              }
            ]}
          />
        }
      />
      <NumberField
        label={translate('sessionSteward.emptySessionCloseMinutes', 'Quiet time before cleanup')}
        description={translate(
          'sessionSteward.emptySessionCloseMinutesHint',
          'How long a blank session sits untouched and off screen before it is cleaned up.'
        )}
        value={config.emptySessionCloseMinutes}
        defaultValue={SESSION_STEWARD_EMPTY_SESSION_MINUTES_DEFAULT}
        min={SESSION_STEWARD_EMPTY_SESSION_MINUTES_MIN}
        max={SESSION_STEWARD_EMPTY_SESSION_MINUTES_MAX}
        integer
        suffix={translate('sessionSteward.minutesSuffix', 'min')}
        onChange={(minutes) => write({ emptySessionCloseMinutes: minutes })}
      />
    </>
  )
}

/** One row per steward switch; every switch is on by default and is an emergency off. */
export function SessionStewardSettingsPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const config = normalizeSessionStewardSettings(settings.sessionSteward)
  const [saveError, setSaveError] = useState<string | null>(null)
  const writes = useRef(0)
  const write = (
    change:
      | Partial<SessionStewardSettings>
      | ((latest: SessionStewardSettings) => Partial<SessionStewardSettings>)
  ): void => {
    const latest = normalizeSessionStewardSettings(
      (useAppStore.getState().settings ?? settings).sessionSteward
    )
    const patch = typeof change === 'function' ? change(latest) : change
    // Why a generation: a slow refusal of an older write must not paint over a later success.
    const generation = ++writes.current
    setSaveError(null)
    Promise.resolve()
      .then(() => updateSettings({ sessionSteward: { ...latest, ...patch } }))
      .then(
        () => {
          if (generation === writes.current) {
            setSaveError(null)
          }
        },
        (failure: unknown) => {
          if (generation === writes.current) {
            setSaveError(failure instanceof Error ? failure.message : String(failure))
          }
        }
      )
  }
  const writeSwitch = (key: StewardSwitch, checked: boolean): void => {
    const patch: Partial<SessionStewardSettings> = {}
    if (key === 'safeYes' || key === 'tier2Archive') {
      patch[key] = checked ? 'on' : 'off'
    } else {
      patch[key] = checked
    }
    write(patch)
  }
  const writeOrganize = (key: OrganizeSwitch, checked: boolean): void => {
    write((latest) => ({
      organize: {
        ...latest.organize,
        [key]: key === 'refile' || key === 'retitle' ? (checked ? 'on' : 'off') : checked
      }
    }))
  }
  return (
    <div className="space-y-3">
      <SettingsSwitchRow
        label={translate('sessionSteward.enabled', 'Let the session steward look after sessions')}
        description={translate(
          'sessionSteward.enabledHint',
          'It runs inside the app on this computer’s sessions only. Everything it does is logged with Undo, and deploys, sends, money and ads always come to you. Off stops every switch below.'
        )}
        checked={config.enabled}
        onChange={() => write({ enabled: !config.enabled })}
      />
      {switchRows().map((row) => {
        const on = config[row.key] === true || config[row.key] === 'on'
        return (
          <Fragment key={row.key}>
            <SettingsSwitchRow
              label={row.label}
              description={row.description}
              checked={on}
              disabled={!config.enabled}
              onChange={() => writeSwitch(row.key, !on)}
            />
            {row.key === 'emptySessionArchive' && config.enabled && on ? (
              <EmptySessionControls config={config} write={write} />
            ) : null}
          </Fragment>
        )
      })}
      {organizeRows().map((row) => {
        const value = config.organize[row.key]
        const on = value === true || value === 'on'
        return (
          <SettingsSwitchRow
            key={row.key}
            label={row.label}
            description={
              value === 'paused'
                ? `${row.description} ${translate('sessionSteward.pausedByGuard', 'Paused by the accuracy guard; switch on to resume.')}`
                : row.description
            }
            checked={on}
            disabled={!config.enabled}
            onChange={() => writeOrganize(row.key, !on)}
          />
        )
      })}
      {saveError ? (
        <p role="alert" className="text-xs text-destructive">
          {translate('sessionSteward.saveFailed', 'This setting was not saved: {{reason}}', {
            reason: saveError
          })}
        </p>
      ) : null}
    </div>
  )
}
