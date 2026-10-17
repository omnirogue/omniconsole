import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { LocalRunDraft, LocalRunGraph } from '../../../../shared/local-run-graph'
import { LOCAL_RUN_RPC } from '../../../../shared/local-run-types'

/**
 * Saved graphs, kept beside automations in Phase 2's own `localRunDrafts` domain. They
 * are definitions a person keeps on this machine — never a queue, never anyone else's.
 */
export function useLocalRunDrafts(): {
  drafts: LocalRunDraft[]
  error: string | null
  refresh: () => void
  save: (params: { id: string; title: string; graph: LocalRunGraph }) => Promise<void>
  remove: (id: string) => Promise<void>
} {
  const [drafts, setDrafts] = useState<LocalRunDraft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { drafts: listed } = await callRuntimeRpc<{ drafts: LocalRunDraft[] }>(
          { kind: 'local' },
          LOCAL_RUN_RPC.listDrafts
        )
        if (!cancelled) {
          setDrafts(listed)
          setError(null)
        }
      } catch (failure) {
        if (!cancelled) {
          setError(String(failure))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [revision])
  const save = useCallback(
    async (params: { id: string; title: string; graph: LocalRunGraph }): Promise<void> => {
      try {
        await callRuntimeRpc({ kind: 'local' }, LOCAL_RUN_RPC.saveDraft, params)
        setError(null)
        refresh()
      } catch (failure) {
        setError(String(failure))
        throw failure
      }
    },
    [refresh]
  )
  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await callRuntimeRpc({ kind: 'local' }, LOCAL_RUN_RPC.removeDraft, { id })
        setError(null)
        refresh()
      } catch (failure) {
        setError(String(failure))
        throw failure
      }
    },
    [refresh]
  )
  return { drafts, error, refresh, save, remove }
}
