import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentWorkingMode,
  type AgentType
} from '../../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import type { DashboardBucket, DashboardCardDotState } from '../../../../shared/dashboard-snapshot'
import type { HumanAttentionRequest } from '../../../../shared/session-human-attention'
import { sessionQuestionIdentity } from '../../../../shared/session-questions'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  buildDashboardSnapshot,
  type DashboardSnapshotState
} from '../dashboard/build-dashboard-snapshot'

/** One live or retained agent pane, projected from the dashboard card machinery. */
export type AgentPaneCard = {
  paneKey: string
  worktreeId: string
  tabId: string
  leafId: string | null
  agentType: AgentType
  bucket: DashboardBucket
  dotState: DashboardCardDotState
  workingMode?: AgentWorkingMode
  /** Live background tasks behind a monitoring card, when the provider counted them. */
  backgroundTaskCount?: number
  activityUnverifiable?: boolean
  stopped?: 'failed' | 'interrupted'
  unreadCompletion?: boolean
  unseen: boolean
  /** Conversation name when known, else the task/prompt; empty for title-only rows. */
  title: string
  /** When the pane entered its current state; 0 when unknown. */
  stateChangedAt: number
  askSummary?: string
  repoName: string
  worktreeName: string
}

export type AttentionCause = 'blocked' | 'waiting'

/** A pursued run's open requests addressed to the owner: the ask, why, and how to meet it. */
export type RunAttention = {
  chainId: string
  /** Sidebar row of the conversation that owns the run; its Up next is where a decision goes. */
  sourceRowKey: string
  /** "Needs you: <ask>". */
  headline: string
  why: string
  requests: readonly HumanAttentionRequest[]
}

export type AttentionPane = AgentPaneCard & {
  cause: AttentionCause
  /** Routable `${tabId}:${leafId}` key for portaling this exact pane; null when the leaf is unresolved. */
  portalPaneKey: string | null
  /** Set when this entry is a run's request rather than a pane's own prompt. */
  run?: RunAttention
  /** Other panes showing this same question (the conversation resumed or mirrored there); they
   *  are not listed again. */
  mirrorPaneKeys?: readonly string[]
}

export type AgentPaneSnapshot = {
  cards: readonly AgentPaneCard[]
  cardsByPaneKey: ReadonlyMap<string, AgentPaneCard>
  cardsByTabId: ReadonlyMap<string, readonly AgentPaneCard[]>
  /** Panes waiting on the user, oldest wait first. */
  attention: readonly AttentionPane[]
  attentionByPaneKey: ReadonlyMap<string, AttentionPane>
  attentionWorktreeIds: ReadonlySet<string>
}

export const EMPTY_AGENT_PANE_SNAPSHOT: AgentPaneSnapshot = {
  cards: [],
  cardsByPaneKey: new Map(),
  cardsByTabId: new Map(),
  attention: [],
  attentionByPaneKey: new Map(),
  attentionWorktreeIds: new Set()
}

function attentionOrder(pane: AttentionPane): number {
  // Why: an unknown state age (title-only rows) must not pin the pane above real waits.
  return pane.stateChangedAt > 0 ? pane.stateChangedAt : Number.POSITIVE_INFINITY
}

export function compareAttentionPanes(left: AttentionPane, right: AttentionPane): number {
  const byAge = attentionOrder(left) - attentionOrder(right)
  if (byAge !== 0 && Number.isFinite(byAge)) {
    return byAge
  }
  if (attentionOrder(left) !== attentionOrder(right)) {
    return Number.isFinite(attentionOrder(left)) ? -1 : 1
  }
  return left.paneKey.localeCompare(right.paneKey)
}

/**
 * Derive every agent pane plus the "needs you" subset from the same rows the
 * dashboard and the sidebar agent lists use, so all three surfaces agree on
 * who is waiting.
 */
export function buildAgentPaneSnapshot(
  state: DashboardSnapshotState,
  now: number
): AgentPaneSnapshot {
  const snapshot = buildDashboardSnapshot(state, now, {
    includeCardDetails: false,
    includeFilterOptions: false
  })
  if (snapshot.cards.length === 0) {
    return EMPTY_AGENT_PANE_SNAPSHOT
  }
  const cards: AgentPaneCard[] = []
  const cardsByPaneKey = new Map<string, AgentPaneCard>()
  const cardsByTabId = new Map<string, AgentPaneCard[]>()
  const attention: AttentionPane[] = []
  const attentionByPaneKey = new Map<string, AttentionPane>()
  const attentionWorktreeIds = new Set<string>()
  for (const card of snapshot.cards) {
    const entry =
      state.agentStatusByPaneKey[card.paneKey] ?? state.retainedAgentsByPaneKey[card.paneKey]?.entry
    const activityUnverifiable = entry
      ? ['working', 'waiting', 'blocked'].includes(entry.state) &&
        !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
      : card.dotState === 'working'
    const projected: AgentPaneCard = {
      paneKey: card.paneKey,
      worktreeId: card.worktreeId,
      tabId: card.tabId,
      leafId: card.leafId,
      agentType: card.agentType,
      bucket: card.bucket,
      dotState: card.dotState,
      ...(card.workingMode ? { workingMode: card.workingMode } : {}),
      ...(card.workingMode && entry?.backgroundTaskCount
        ? { backgroundTaskCount: entry.backgroundTaskCount }
        : {}),
      ...(activityUnverifiable ? { activityUnverifiable: true } : {}),
      ...(entry?.state === 'done' && (entry.failed || entry.interrupted)
        ? { stopped: entry.failed ? ('failed' as const) : ('interrupted' as const) }
        : {}),
      unseen: card.unseen,
      ...(card.dotState === 'done' &&
      card.unseen &&
      !entry?.failed &&
      !entry?.interrupted &&
      !entry?.sessionBoundary
        ? { unreadCompletion: true }
        : {}),
      title: card.conversationName ?? card.task,
      stateChangedAt: card.stateChangedAt,
      ...(card.askSummary ? { askSummary: card.askSummary } : {}),
      repoName: card.repoName,
      worktreeName: card.worktreeName
    }
    cards.push(projected)
    cardsByPaneKey.set(projected.paneKey, projected)
    const tabCards = cardsByTabId.get(projected.tabId) ?? []
    tabCards.push(projected)
    cardsByTabId.set(projected.tabId, tabCards)
    if (
      card.bucket !== 'attention' ||
      (card.dotState !== 'blocked' && card.dotState !== 'waiting')
    ) {
      continue
    }
    const routable = card.leafId
      ? makePaneKey(card.tabId, card.leafId)
      : parsePaneKey(card.paneKey)
        ? card.paneKey
        : null
    const pane: AttentionPane = { ...projected, cause: card.dotState, portalPaneKey: routable }
    attention.push(pane)
    attentionByPaneKey.set(pane.paneKey, pane)
    attentionWorktreeIds.add(pane.worktreeId)
  }
  const listed = withoutMirroredQuestions(attention, state)
  listed.sort(compareAttentionPanes)
  return {
    cards,
    cardsByPaneKey,
    cardsByTabId,
    attention: listed,
    attentionByPaneKey: new Map(listed.map((pane) => [pane.paneKey, pane])),
    attentionWorktreeIds
  }
}

type QuestionCopy = AttentionPane & { questionCopyRestored: boolean }

/** The copy that carries the question: a live row over a restored or stale one, then the pane
 *  that has waited longest (the one that asked), then a stable key order. */
function preferQuestionCopy(left: QuestionCopy, right: QuestionCopy): number {
  return (
    Number(left.questionCopyRestored) - Number(right.questionCopyRestored) ||
    Number(left.activityUnverifiable === true) - Number(right.activityUnverifiable === true) ||
    attentionOrder(left) - attentionOrder(right) ||
    left.paneKey.localeCompare(right.paneKey)
  )
}

/**
 * One row per question: a conversation that shows the same pending question in several panes
 * (resumed into a second pane here, or mirrored from another computer) needs the person once,
 * not once per pane. The other copies are named on the surviving row.
 */
function withoutMirroredQuestions(
  attention: AttentionPane[],
  state: DashboardSnapshotState
): AttentionPane[] {
  const byQuestion = new Map<string, QuestionCopy[]>()
  const keyed = attention.map((pane) => {
    const entry = state.agentStatusByPaneKey[pane.paneKey]
    const identity = !pane.run && entry ? sessionQuestionIdentity(entry) : null
    return { pane, identity, restored: entry?.restoredUnconfirmed === true }
  })
  if (!keyed.some((item) => item.identity !== null)) {
    return attention
  }
  for (const { pane, identity, restored } of keyed) {
    if (identity === null) {
      continue
    }
    const copies = byQuestion.get(identity) ?? []
    copies.push({ ...pane, questionCopyRestored: restored })
    byQuestion.set(identity, copies)
  }
  const kept = new Map<string, AttentionPane>()
  for (const copies of byQuestion.values()) {
    const [first, ...rest] = copies.toSorted(preferQuestionCopy)
    const { questionCopyRestored: _restored, ...pane } = first!
    kept.set(
      pane.paneKey,
      rest.length > 0 ? { ...pane, mirrorPaneKeys: rest.map((copy) => copy.paneKey) } : pane
    )
  }
  return keyed.flatMap(({ pane, identity }) =>
    identity === null ? [pane] : kept.has(pane.paneKey) ? [kept.get(pane.paneKey)!] : []
  )
}
