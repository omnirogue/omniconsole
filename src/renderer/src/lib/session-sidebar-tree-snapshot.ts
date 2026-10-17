import { useEffect, useMemo, useRef } from 'react'
import type {
  AgentPaneCard,
  AgentPaneSnapshot,
  AttentionPane
} from '@/components/attention/agent-pane-snapshot'

/** The part of the pane snapshot the sidebar tree and its rows read; the rest is noise to them. */
export type SessionSidebarTreeSnapshot = Pick<
  AgentPaneSnapshot,
  'cardsByPaneKey' | 'cardsByTabId' | 'attentionByPaneKey'
>

function sameCard(left: AgentPaneCard, right: AgentPaneCard): boolean {
  return (
    left === right ||
    (left.paneKey === right.paneKey &&
      left.worktreeId === right.worktreeId &&
      left.tabId === right.tabId &&
      left.bucket === right.bucket &&
      left.dotState === right.dotState &&
      left.workingMode === right.workingMode &&
      left.backgroundTaskCount === right.backgroundTaskCount &&
      left.activityUnverifiable === right.activityUnverifiable &&
      left.stopped === right.stopped &&
      left.unreadCompletion === right.unreadCompletion &&
      left.stateChangedAt === right.stateChangedAt &&
      left.askSummary === right.askSummary)
  )
}

function sameAttentionPane(left: AttentionPane, right: AttentionPane): boolean {
  return (
    left === right ||
    (sameCard(left, right) &&
      left.cause === right.cause &&
      left.portalPaneKey === right.portalPaneKey)
  )
}

function sameMap<T>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, T>,
  equal: (a: T, b: T) => boolean
): boolean {
  if (left === right) {
    return true
  }
  if (left.size !== right.size) {
    return false
  }
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other === undefined || !equal(value, other)) {
      return false
    }
  }
  return true
}

function sameCardLists(left: readonly AgentPaneCard[], right: readonly AgentPaneCard[]): boolean {
  return (
    left === right ||
    (left.length === right.length && left.every((card, index) => sameCard(card, right[index]!)))
  )
}

export function sameSessionSidebarTreeSnapshot(
  left: SessionSidebarTreeSnapshot,
  right: SessionSidebarTreeSnapshot
): boolean {
  return (
    sameMap(left.cardsByPaneKey, right.cardsByPaneKey, sameCard) &&
    sameMap(left.cardsByTabId, right.cardsByTabId, sameCardLists) &&
    sameMap(left.attentionByPaneKey, right.attentionByPaneKey, sameAttentionPane)
  )
}

/**
 * The snapshot the tree depends on, kept at its previous identity while nothing the tree reads
 * changed — so a status ping that only moved a token count or a title rebuilds nothing.
 */
export function useSessionSidebarTreeSnapshot(
  snapshot: AgentPaneSnapshot
): SessionSidebarTreeSnapshot {
  const previous = useRef<SessionSidebarTreeSnapshot | null>(null)
  const shared = useMemo(() => {
    const next: SessionSidebarTreeSnapshot = {
      cardsByPaneKey: snapshot.cardsByPaneKey,
      cardsByTabId: snapshot.cardsByTabId,
      attentionByPaneKey: snapshot.attentionByPaneKey
    }
    const prior = previous.current
    return prior && sameSessionSidebarTreeSnapshot(prior, next) ? prior : next
  }, [snapshot])
  useEffect(() => {
    previous.current = shared
  }, [shared])
  return shared
}
