import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL_RUN_RPC, type LocalRunSnapshot } from '../../../../shared/local-run-types'

/**
 * Every local Run this desktop is executing, read from the runner and refreshed when
 * it says something changed. It is not a queue and never lists anyone else's work:
 * `localRun.list` returns the runs started on this machine, by this person.
 */
export function useLocalRuns(): {
  runs: LocalRunSnapshot[]
  error: string | null
  loading: boolean
  refresh: () => void
  applyRun: (run: LocalRunSnapshot) => void
} {
  const [runs, setRuns] = useState<LocalRunSnapshot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const applyRun = useCallback((next: LocalRunSnapshot) => {
    setRuns((current) => {
      const known = current.some((run) => run.id === next.id)
      return known ? current.map((run) => (run.id === next.id ? next : run)) : [next, ...current]
    })
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const { runs: listed } = await callRuntimeRpc<{ runs: LocalRunSnapshot[] }>(
          { kind: 'local' },
          LOCAL_RUN_RPC.list
        )
        if (!cancelled) {
          setRuns(listed)
          setError(null)
        }
      } catch (failure) {
        if (!cancelled) {
          setError(String(failure))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [revision])
  useEffect(() => window.api?.localRun?.onChanged?.(() => refresh()), [refresh])
  return { runs, error, loading, refresh, applyRun }
}
