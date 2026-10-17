import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { SESSION_ORGANIZATION_RPC } from '../../../shared/session-organization-change'
import type {
  OrganizationRecentResult,
  OrganizationSessionHistory
} from '../../../shared/session-organization-readers'

export type Read<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** One local runtime read; `reload` asks again. */
export function useRuntimeRead<T>(method: string, params: unknown, enabled: boolean): Read<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const paramsKey = JSON.stringify(params)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let live = true
    setLoading(true)
    callRuntimeRpc<T>({ kind: 'local' }, method, JSON.parse(paramsKey))
      .then((result) => {
        if (live) {
          setData(result)
          setError(null)
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [enabled, method, paramsKey, revision])
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { data, error, loading, reload }
}

/** A session's recorded history: its sidebar key plus the pane and tab keys it had before. */
export function useOrganizationHistory(
  key: string,
  aliases: readonly string[],
  enabled: boolean
): Read<OrganizationSessionHistory> {
  return useRuntimeRead<OrganizationSessionHistory>(
    SESSION_ORGANIZATION_RPC.history,
    aliases.length > 0 ? { key, aliases: [...aliases] } : { key },
    enabled
  )
}

/** Changes of the last 24 hours (main's default window), newest first. */
export function useRecentOrganizationChanges(enabled = true): Read<OrganizationRecentResult> {
  return useRuntimeRead<OrganizationRecentResult>(SESSION_ORGANIZATION_RPC.recent, {}, enabled)
}
