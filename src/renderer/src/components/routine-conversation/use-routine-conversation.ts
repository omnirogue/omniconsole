import { useCallback, useEffect, useState } from 'react'
import { companiesData, conversationApi, conversationError } from './routine-conversation-data'
import type { BoardConversationTurn } from '../../../../shared/console-routine-conversation-contract'

export function useRoutineConversation(
  taskId: string,
  active: boolean,
  refreshRuns: () => Promise<void>
) {
  const [messages, setMessages] = useState<BoardConversationTurn[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [visible, setVisible] = useState(!document.hidden)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    const changed = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  // One read per revision. The next poll is scheduled by the effect below, which owns its timer.
  const [settled, setSettled] = useState({ count: 0, failures: 0 })
  useEffect(() => {
    let live = visible
    async function read() {
      let failed = false
      try {
        const response = companiesData(await conversationApi().getConversation({ taskId }))
        if (!response.ok) {
          throw new Error(response.reason ?? response.code)
        }
        if (!live) {
          return
        }
        setMessages(response.messages ?? [])
        setError('')
        if (active) {
          await refreshRuns()
        }
      } catch (reason) {
        if (!live) {
          return
        }
        setError(conversationError(reason))
        failed = true
      } finally {
        if (live) {
          setLoading(false)
          setSettled((last) => ({
            count: last.count + 1,
            failures: failed ? last.failures + 1 : 0
          }))
        }
      }
    }
    // A hidden window reads nothing; the effect reruns when it becomes visible again.
    if (visible) {
      void read()
    }
    return () => {
      live = false
    }
  }, [taskId, active, refreshRuns, revision, visible])
  useEffect(() => {
    // Poll only an active run in a visible window, backing off after failures.
    if (!active || !visible || settled.count === 0) {
      return undefined
    }
    const timer = setTimeout(
      () => setRevision((value) => value + 1),
      Math.min(8000 * 2 ** settled.failures, 60000)
    )
    return () => clearTimeout(timer)
  }, [active, visible, settled])
  return { messages, error, loading, refresh }
}
