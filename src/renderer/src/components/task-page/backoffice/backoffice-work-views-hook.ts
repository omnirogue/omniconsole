import { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { subscribeWorkRefresh } from './backoffice-work-refresh'
import {
  emptyBackofficeReads,
  loadBackofficeWork,
  useBackofficeWorkStore
} from './backoffice-work-store'
import { toWorkViewsInput, valueOf, type WorkReads, type WorkLoad } from './backoffice-work-reads'
import { useAnsweredHandoffQuestions, withoutAnsweredQuestions } from './handoff-question-answered'
import {
  buildWorkViews,
  type WorkViews,
  type WorkFollowUpRow
} from '../../../../../shared/backoffice-work-views'

const EMPTY_FOLLOW_UPS: readonly WorkFollowUpRow[] = []

export function useBackofficeWorkViews(
  scope: string,
  enabled: boolean,
  followUps: readonly WorkFollowUpRow[] = EMPTY_FOLLOW_UPS,
  /** `history`: this surface shows finished requests, so the resolved history is read too. */
  options: { history?: boolean } = {}
): {
  views: WorkViews
  reads: WorkReads
  names: ReadonlyMap<string, string>
  loading: boolean
  refresh: () => void
} {
  const reads = useBackofficeWorkStore(
    useShallow((state) =>
      state.scope === scope
        ? {
            todo: state.todo,
            receivedOpen: state.receivedOpen,
            receivedHistory: state.receivedHistory,
            sent: state.sent,
            roster: state.roster,
            humanActions: state.humanActions,
            messages: state.messages
          }
        : emptyBackofficeReads()
    )
  )
  const history = options.history === true
  useEffect(() => {
    if (!enabled) {
      return
    }
    void loadBackofficeWork(scope, history ? { history: true } : {})
    return subscribeWorkRefresh(scope, (peerWake) => {
      return loadBackofficeWork(scope, { reconcile: true, peerWake })
    })
  }, [enabled, history, scope])
  const answered = useAnsweredHandoffQuestions((state) => state.ids)
  const views = useMemo(
    () => withoutAnsweredQuestions(buildWorkViews(toWorkViewsInput(reads, followUps)), answered),
    [reads, followUps, answered]
  )
  const names = useMemo(
    () => new Map((valueOf(reads.roster) ?? []).map((person) => [person.id, person.name])),
    [reads.roster]
  )
  const refresh = useCallback(() => void loadBackofficeWork(scope, { force: true }), [scope])
  // Why: a read not yet started is loading too; before its first answer nothing is known missing.
  // An idle history was not asked for, so nothing waits on it.
  const loading = Object.entries(reads).some(
    ([key, load]: [string, WorkLoad<unknown>]) =>
      (enabled && load.phase === 'idle' && key !== 'receivedHistory') ||
      (load.phase === 'loading' && load.previous === null)
  )
  return { views, reads, names, loading, refresh }
}
