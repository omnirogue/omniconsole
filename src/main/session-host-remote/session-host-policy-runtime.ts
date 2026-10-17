/**
 * Main's wiring for the synced automation overrides: publish through the organization host's
 * outbox, hear each account sync pass, and follow Settings. The host switches read `effective()`.
 */

import type { GlobalSettings } from '../../shared/global-settings-types'
import { sessionOrganizationHostFor } from '../session-organization/host-organization-instance'
import { onStewardSyncEntries } from '../session-organization/steward-sync-main'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { startSessionHostPolicySync, type SessionHostPolicySync } from './session-host-policy-sync'

type SettingsStore = {
  getSettings(): GlobalSettings
  onSettingsChanged(
    listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
  ): () => void
}

export function startSessionHostPolicies(input: { store: SettingsStore; userDataPath: string }): {
  policies: SessionHostPolicySync
  stop: () => void
} {
  let ownHostId: string | null = null
  // Why async: the host id is minted with the host's journal; until then no ack is owed.
  void activeRuntimeSessionHost()
    ?.service()
    .then((service) => {
      ownHostId = service.identity.hostId
    })
    .catch(() => {})
  const policies = startSessionHostPolicySync({
    userDataPath: input.userDataPath,
    now: Date.now,
    publish: (entries) => {
      sessionOrganizationHostFor(input.userDataPath).publish(entries)
    },
    ownHostId: () => ownHostId
  })
  policies.onSettings(input.store.getSettings().sessionHostControl)
  const stopSettings = input.store.onSettingsChanged((updates, settings) => {
    if ('sessionHostControl' in updates) {
      policies.onSettings(settings.sessionHostControl)
    }
  })
  const stopEntries = onStewardSyncEntries((entries) => policies.ingest(entries))
  return {
    policies,
    stop: () => {
      stopSettings()
      stopEntries()
    }
  }
}
