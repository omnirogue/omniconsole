import { useCallback, useEffect, useState } from 'react'
import type {
  RoutineSlackChannel,
  RoutineSlackStatus
} from '../../../../shared/routine-alert-contract'

export function useRoutineSlack() {
  const [status, setStatus] = useState<RoutineSlackStatus | null>(null)
  const [channels, setChannels] = useState<RoutineSlackChannel[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const next = await window.api.alerts.slack.status()
      setStatus(next)
      setError(next.error ?? null)
      setChannels(
        next.authenticated && next.connection
          ? await window.api.alerts.slack.listChannels(true)
          : []
      )
    } catch (reason) {
      setError(String(reason))
    }
  }, [])
  useEffect(() => {
    let active = true
    void window.api.alerts.slack
      .status()
      .then(async (next) => {
        if (!active) {
          return
        }
        setStatus(next)
        setError(next.error ?? null)
        if (next.authenticated && next.connection) {
          const rows = await window.api.alerts.slack.listChannels()
          if (active) {
            setChannels(rows)
          }
        }
      })
      .catch((reason) => {
        if (active) {
          setError(String(reason))
        }
      })
    return () => {
      active = false
    }
  }, [])
  return { status, channels, error, refresh }
}
