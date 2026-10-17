import { useMemo } from 'react'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { useAgentPaneSnapshot } from '@/components/attention/use-agent-pane-snapshot'
import { useSessionFollowUpRows } from '@/lib/session-follow-up-rows'
import { waitLaterKeyForPane } from '@/lib/wait-later'
import { useWorktreeMap } from '@/store/selectors'
import { useWaitingKeys } from '@/store/wait-later-store'
import type { WorkViews } from '../../../../../shared/backoffice-work-views'
import { useBackofficeWorkViews } from './backoffice-work-store'
import { withoutWaitingThreads } from './backoffice-work-waiting'

export type NeedsYouCounts = {
  /**
   * What the sessions ask of the person, minus what was put away with ⏳: an ordinary
   * conversation's own live prompt, and each pursued run's open request, once. A run's blocked,
   * failed, idle or finished panes are never in it (`useAgentPaneSnapshot`).
   */
  panes: number
  /** Console rows that need the person (cards, threads, decisions, messages, follow-ups). */
  work: number
  /** The one "need you" number every surface shows: panes + work. */
  total: number
  /** Console rows waiting on someone else; a pane never waits. */
  waiting: number
}

/**
 * The single formula behind every "N need you": the Work badge, the Work home and the
 * Attention summary all read this, so they cannot disagree. Panes come from the pane
 * snapshot, console rows from the one work store with the saved follow-ups folded in.
 */
export function useNeedsYouCounts(
  scope: string,
  enabled: boolean
): {
  panes: readonly AttentionPane[]
  views: WorkViews
  counts: NeedsYouCounts
  loading: boolean
} {
  const snapshot = useAgentPaneSnapshot()
  const waiting = useWaitingKeys()
  const followUps = useSessionFollowUpRows()
  const worktrees = useWorktreeMap()
  const projected = useBackofficeWorkViews(scope, enabled, followUps)
  const views = useMemo(
    () => withoutWaitingThreads(projected.views, waiting),
    [projected.views, waiting]
  )
  const needsYouCards = useMemo(
    () =>
      new Set(views.needsYou.map((row) => row.taskId).filter((id): id is string => id !== null)),
    [views.needsYou]
  )
  const panes = useMemo(
    () =>
      snapshot.attention.filter((pane) => {
        if (waiting.has(waitLaterKeyForPane(pane.paneKey))) {
          return false
        }
        // Why: a run's request names its own requirement; no card row stands in for it.
        if (pane.run) {
          return true
        }
        // Why: a pane whose workspace is bound to a card already in Needs You is the SAME
        // obligation; the card row carries the three controls, so the pane row stands down.
        const card = worktrees.get(pane.worktreeId)?.linkedWorkItem?.hubTaskId
        return !(card && needsYouCards.has(card))
      }),
    [snapshot.attention, waiting, worktrees, needsYouCards]
  )
  const work = views.counts.needsYou
  const counts = useMemo(
    () => ({
      panes: panes.length,
      work,
      total: panes.length + work,
      waiting: views.counts.waitingFor
    }),
    [panes.length, work, views.counts.waitingFor]
  )
  return { panes, views, counts, loading: projected.loading }
}
