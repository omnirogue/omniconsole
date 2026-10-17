/**
 * Writes `GlobalSettings.sessionHostControl` from the latest store value, so two quick changes
 * never overwrite each other, and reports a failed save (`updateSettingsOrThrow`).
 */

import { useCallback, useRef, useState } from 'react'
import {
  normalizeSessionHostControlSettings,
  type SessionHostControlSettings
} from '../../../shared/session-host-control-settings'
import { useAppStore } from '@/store'

export function latestSessionHostControl(): SessionHostControlSettings {
  return normalizeSessionHostControlSettings(useAppStore.getState().settings?.sessionHostControl)
}

export function useSessionHostControlWrite(): {
  write: (
    change: (latest: SessionHostControlSettings) => Partial<SessionHostControlSettings>
  ) => Promise<void>
  error: string | null
} {
  const [error, setError] = useState<string | null>(null)
  const writes = useRef(0)
  const write = useCallback(
    (change: (latest: SessionHostControlSettings) => Partial<SessionHostControlSettings>) => {
      const latest = latestSessionHostControl()
      // Why a generation: a slow refusal of an older write must not paint over a later success.
      const generation = ++writes.current
      setError(null)
      return useAppStore
        .getState()
        .updateSettingsOrThrow({ sessionHostControl: { ...latest, ...change(latest) } })
        .then(
          () => {
            if (generation === writes.current) {
              setError(null)
            }
          },
          (failure: unknown) => {
            if (generation === writes.current) {
              setError(failure instanceof Error ? failure.message : String(failure))
            }
          }
        )
    },
    []
  )
  return { write, error }
}

/** A folder's or host's override set to automation off, or back on (an empty, newer override). */
export function withAutomation(
  policies: SessionHostControlSettings['folderPolicies'],
  key: string,
  off: boolean
): SessionHostControlSettings['folderPolicies'] {
  const { automation: _automation, ...rest } = policies[key] ?? {}
  return { ...policies, [key]: off ? { ...rest, automation: 'off' } : rest }
}
