import { useEffect, useState } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { inboxPeople, type InboxPerson } from './inbox-api'

/**
 * The roster the composer offers as recipients. A separate, optional read:
 * a failure here must never hide the Inbox itself.
 */
export function useInboxPeople(revision: number) {
  const scope = useHandoffScope()
  const [result, setResult] = useState({
    scope,
    people: [] as InboxPerson[],
    error: '',
    loading: true
  })
  useEffect(() => {
    let live = true
    setResult({ scope, people: [], error: '', loading: true })
    void Promise.resolve()
      .then(() => inboxPeople())
      .then(
        (roster) => {
          if (live) {
            setResult({ scope, people: roster, error: '', loading: false })
          }
        },
        (reason: unknown) => {
          if (live) {
            setResult({
              scope,
              people: [],
              error: reason instanceof Error ? reason.message : String(reason),
              loading: false
            })
          }
        }
      )
    return () => {
      live = false
    }
  }, [scope, revision])
  return result.scope === scope ? result : { people: [], error: '', loading: true }
}

/** Room composers read loading and error with the roster; same scoped read as useInboxPeople. */
export function useInboxPeopleState(revision: number) {
  return useInboxPeople(revision)
}
