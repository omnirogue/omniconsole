import { useCallback, useEffect, useRef, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage,
  WorkflowRequestError
} from '@/lib/console-workflow-client'
import type { WorkBoard } from '../../../../../shared/console-work-home-contract'

export const WORK_REFRESH_MS = 30_000

/** Latest-request wins; transient failures keep the last board in this account only. */
export function useWorkBoardData(scope: string, refreshKey: number, revision: number) {
  const [snapshot, setSnapshot] = useState<{
    scope: string
    data: WorkBoard | null
    error: string | null
    updated: string | null
  }>({ scope, data: null, error: null, updated: null })
  const generation = useRef(0)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const data = workflowData(await consoleWorkflowApi().listWork())
      if (request === generation.current) {
        setSnapshot({ scope, data, error: null, updated: new Date().toLocaleTimeString() })
      }
      return data
    } catch (reason) {
      if (request === generation.current) {
        const revoked =
          reason instanceof WorkflowRequestError &&
          ([
            'forbidden',
            'unauthorized',
            'connection_changed',
            'principal_mismatch',
            'signed_in_required'
          ].includes(reason.detail.code) ||
            [401, 403].includes(reason.detail.status ?? 0))
        setSnapshot((previous) => ({
          scope,
          data: !revoked && previous.scope === scope ? previous.data : null,
          error: workflowErrorMessage(reason),
          updated: previous.scope === scope ? previous.updated : null
        }))
      }
      throw reason
    }
  }, [scope])
  useEffect(() => {
    let busy = false
    const poll = async () => {
      if (busy) {
        return
      }
      busy = true
      try {
        await refresh()
      } catch {
        /* The snapshot carries the error. */
      } finally {
        busy = false
      }
    }
    const visible = () => {
      if (document.visibilityState !== 'hidden') {
        void poll()
      }
    }
    void poll()
    const timer = setInterval(visible, WORK_REFRESH_MS)
    window.addEventListener('focus', visible)
    return () => {
      invalidate()
      clearInterval(timer)
      window.removeEventListener('focus', visible)
    }
  }, [refresh, refreshKey, revision, invalidate])
  return {
    ...(snapshot.scope === scope ? snapshot : { data: null, error: null, updated: null }),
    refresh
  }
}
