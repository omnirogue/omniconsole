import { useMemo } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeSessionHostControlSettings } from '../../../../shared/session-host-control-settings'
import type { HostSwitchReading } from '../../../../shared/session-hosts-status'
import { translate } from '@/i18n/i18n'
import { useSessionHostsStatus } from '@/lib/session-hosts-client'
import { useSessionHostControlWrite, withAutomation } from '@/lib/session-host-control-write'
import { useSessionFolders } from '@/store/session-folders'
import { Button } from '../ui/button'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'
import { SettingsSwitchRow } from './SettingsFormControls'

type ThisHostSwitch = 'remoteControls' | 'hostStewardship' | 'relocation'

function thisHostRows(): { key: ThisHostSwitch; label: string; description: string }[] {
  return [
    {
      key: 'remoteControls',
      label: translate('sessionHosts.remoteControls', 'Let other computers control its sessions'),
      description: translate(
        'sessionHosts.remoteControlsHint',
        'Your other Macs can continue, ask, answer, stop and restart the sessions this computer runs. It checks its own rules and carries each out once. Sessions an SSH host runs follow that host’s own switch instead, including this Mac’s automatic prompts sent through it.'
      )
    },
    {
      key: 'hostStewardship',
      label: translate('sessionHosts.hostStewardship', 'Allow automatic actions on its sessions'),
      description: translate(
        'sessionHosts.hostStewardshipHint',
        'The steward, and automatic callers from other computers, may act on the sessions this computer runs. Off stops new automatic actions; it never retracts what was already delivered.'
      )
    },
    {
      key: 'relocation',
      label: translate('sessionHosts.relocation', 'Allow moving conversations to or from it'),
      description: translate(
        'sessionHosts.relocationHint',
        'Only when you ask. Moving a conversation to another computer is not available in this version yet; hand the work off instead.'
      )
    }
  ]
}

function switchCaption(reading: HostSwitchReading | undefined, label: string): string {
  if (!reading || reading.automation === 'on') {
    return translate(
      'sessionHosts.hostOnHint',
      'Automatic actions are allowed on {{label}}’s sessions.',
      { label }
    )
  }
  if (reading.state === 'pending') {
    return translate(
      'sessionHosts.hostPending',
      'Off, waiting for {{label}} to confirm (it may be unreachable).',
      { label }
    )
  }
  return reading.setHere
    ? translate('sessionHosts.hostApplied', '{{label}} confirmed: automatic actions are off.', {
        label
      })
    : translate(
        'sessionHosts.hostAppliedElsewhere',
        'Switched off from another Mac; {{label}} confirmed.',
        {
          label
        }
      )
}

/** This computer as an execution host, the other computers' automation, and folder overrides. */
export function SessionHostSettingsPane({
  settings
}: {
  settings: GlobalSettings
}): React.JSX.Element {
  const config = normalizeSessionHostControlSettings(settings.sessionHostControl)
  const { write, error } = useSessionHostControlWrite()
  const status = useSessionHostsStatus()
  const folders = useSessionFolders()
  const { hostOptions } = useSidebarHostScopeOptions()
  const labels = useMemo(
    () => new Map(hostOptions.map((host) => [host.id as string, host.label])),
    [hostOptions]
  )
  const readings = new Map((status?.switches ?? []).map((reading) => [reading.hostId, reading]))
  const hosts = (status?.hosts ?? []).filter((host) => host.hostId)
  const folderName = (folderId: string) =>
    folders.metadata.folders.find((folder) => folder.id === folderId)?.name ?? folderId
  const offFolders = Object.entries(status?.folderPolicies ?? config.folderPolicies)
    .filter(([, policy]) => policy.automation === 'off')
    .map(([folderId]) => folderId)
  return (
    <div className="space-y-3">
      {thisHostRows().map((row) => (
        <SettingsSwitchRow
          key={row.key}
          label={row.label}
          description={row.description}
          checked={config[row.key]}
          onChange={() => write((latest) => ({ [row.key]: !latest[row.key] }))}
        />
      ))}
      {hosts.map((host) => {
        const hostId = host.hostId!
        const label = labels.get(host.hostKey) ?? host.hostKey
        const reading = readings.get(hostId)
        const on = reading?.automation !== 'off'
        return (
          <SettingsSwitchRow
            key={host.hostKey}
            label={translate('sessionHosts.hostAutomation', 'Automatic actions on {{label}}', {
              label
            })}
            description={switchCaption(reading, label)}
            checked={on}
            onChange={() =>
              write((latest) => ({
                hostPolicies: withAutomation(latest.hostPolicies, hostId, on)
              }))
            }
          />
        )
      })}
      {offFolders.length > 0 ? (
        <div className="space-y-1.5" data-host-folder-overrides={offFolders.length}>
          <p className="text-sm font-medium">
            {translate('sessionHosts.foldersOff', 'Folders with automatic actions off')}
          </p>
          {offFolders.map((folderId) => (
            <div key={folderId} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{folderName(folderId)}</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  write((latest) => ({
                    folderPolicies: withAutomation(latest.folderPolicies, folderId, false)
                  }))
                }
              >
                {translate('sessionHosts.folderOn', 'Turn back on')}
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {translate(
              'sessionHosts.foldersHint',
              'Set a folder from its menu in the sidebar. Every computer applies it to the sessions it runs.'
            )}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {translate('sessionHosts.saveFailed', 'This setting was not saved: {{reason}}', {
            reason: error
          })}
        </p>
      ) : null}
    </div>
  )
}
