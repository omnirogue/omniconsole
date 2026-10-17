import { useCallback, useEffect, useRef, useState } from 'react'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import { useAppStore } from '@/store'

const NO_TITLES: ReadonlyMap<string, string> = new Map()
const NO_IDS: ReadonlySet<string> = new Set()
/** A refused read repairs itself; an id the console simply does not carry is not retried. */
const TITLE_RETRY_DELAY_MS = 5_000
const TITLE_RETRY_LIMIT = 2

export type WorkCardTitlesStatus = 'idle' | 'loading' | 'ready' | 'error'

export type WorkCardTitles = {
  titles: ReadonlyMap<string, string>
  /**
   * Ids the last read could not settle: it was refused, or the board came back capped and
   * omitted them. Distinct from an id the console answered for and does not have.
   */
  unresolved: ReadonlySet<string>
  status: WorkCardTitlesStatus
  retry: () => void
}

/**
 * Titles for hub cards this device knows only by id (a session filed on another computer, or
 * before the link carried a title). One work read per new set of ids, scoped to the account
 * the ids were read under, so a title fetched for one account never shows under another.
 */
export function useWorkCardTitles(ids: readonly string[]): WorkCardTitles {
  const accountScope = useAppStore(selectConsoleAccountScope)
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(NO_TITLES)
  const [unresolved, setUnresolved] = useState<ReadonlySet<string>>(NO_IDS)
  const [status, setStatus] = useState<WorkCardTitlesStatus>('idle')
  const [attempt, setAttempt] = useState(0)
  const [retryPending, setRetryPending] = useState(false)
  // Why: ids the console has already answered for, per account — never asked twice.
  const settled = useRef(new Map<string, Set<string>>())
  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  useEffect(() => {
    // Why: another account's cards are another account's secrets; nothing survives the switch.
    settled.current.delete(accountScope)
    setTitles(NO_TITLES)
    setUnresolved(NO_IDS)
    setStatus('idle')
    setAttempt(0)
    setRetryPending(false)
  }, [accountScope])
  useEffect(() => {
    const asked = settled.current.get(accountScope) ?? new Set<string>()
    settled.current.set(accountScope, asked)
    const unknown = ids.filter((id) => !asked.has(id))
    if (unknown.length === 0) {
      return
    }
    let live = true
    setStatus('loading')
    void Promise.resolve()
      .then(() => consoleWorkflowApi().listWork())
      .then((result) => {
        const board = workflowData(result)
        const found = new Map(board.items.map((card) => [card.id, card.title]))
        if (!live) {
          return
        }
        // Why: a capped board omits cards it never looked at, so an id missing from it is
        // unread, not absent — marking it answered would hide the task's name forever.
        const capped = board.capped === true
        const missed = new Set<string>()
        for (const id of unknown) {
          if (found.has(id) || !capped) {
            asked.add(id)
          }
          if (!found.has(id)) {
            missed.add(id)
          }
        }
        setTitles((current) => {
          const next = new Map(current)
          for (const id of ids) {
            const title = found.get(id)
            if (title) {
              next.set(id, title)
            }
          }
          return next.size === current.size ? current : next
        })
        setUnresolved(missed.size === 0 ? NO_IDS : missed)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!live) {
          return
        }
        // Why: an unreachable console is not evidence that the task has no name — the group
        // keeps showing the card id, says the read failed, and asks again.
        console.warn('[session-sidebar] work card titles unavailable', error)
        setUnresolved(new Set(unknown))
        setStatus('error')
        if (attempt < TITLE_RETRY_LIMIT) {
          setRetryPending(true)
        }
      })
    return () => {
      live = false
    }
  }, [accountScope, attempt, ids])
  // The timer is created at the top of its own effect so the cleanup always owns it;
  // scheduling it inside the failed read's catch left it outside React's reach.
  useEffect(() => {
    if (!retryPending) {
      return
    }
    const timer = setTimeout(() => {
      setRetryPending(false)
      setAttempt((count) => count + 1)
    }, TITLE_RETRY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [retryPending])
  return { titles, unresolved, status, retry }
}
