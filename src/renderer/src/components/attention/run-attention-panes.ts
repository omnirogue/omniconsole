import { sessionRunPaneRole } from '@/lib/session-run-panes'
import { sessionRunRowState, type SessionRunRowState } from '@/lib/session-run-row-state'
import { waitLaterKeyForPane } from '@/lib/wait-later'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  compareAttentionPanes,
  type AgentPaneCard,
  type AgentPaneSnapshot,
  type AttentionPane
} from './agent-pane-snapshot'

type Reading = { chain: SessionChain; run: SessionRunRowState }

/**
 * Whether a pane's hook state belongs to a run rather than to a person. A run's workers stop,
 * idle and wait as part of the run, and a failed run's panes stopped with it: only the run's own
 * requests may ask. What is the conversation's own again is a prompt newer than a finished run,
 * and the source's question before the run owns that source (the row classifier reads the same).
 */
function ownsPane({ chain, run }: Reading, pane: AttentionPane): boolean {
  const role = sessionRunPaneRole(chain, pane)
  if (!role) {
    return false
  }
  if (run.phase === 'completed') {
    return pane.stateChangedAt <= (run.completedAt ?? 0)
  }
  return run.settled || role === 'worker' || chain.outcomeSet?.continuation.sourceReady === true
}

function cardFor(
  { chain, run }: Reading,
  cards: AgentPaneSnapshot['cardsByPaneKey']
): AgentPaneCard {
  const asked = run.requests[0]?.action?.paneKey
  const card = (asked ? cards.get(asked) : undefined) ?? cards.get(chain.sourcePaneKey)
  if (card) {
    return card
  }
  // Why: a run carries on with its conversation closed, and its request must still be listed.
  const agent = chain.steps.find((step) => step.kind !== 'handoff')
  return {
    paneKey: chain.sourcePaneKey,
    worktreeId: chain.worktreeId,
    tabId: parsePaneKey(chain.sourcePaneKey)?.tabId ?? '',
    leafId: null,
    agentType: agent?.agent ?? 'unknown',
    bucket: 'attention',
    dotState: 'blocked',
    unseen: false,
    title: '',
    stateChangedAt: 0,
    repoName: '',
    worktreeName: ''
  }
}

function requestPane(reading: Reading, cards: AgentPaneSnapshot['cardsByPaneKey']): AttentionPane {
  const { chain, run } = reading
  const card = cardFor(reading, cards)
  const routable = card.leafId
    ? makePaneKey(card.tabId, card.leafId)
    : parsePaneKey(card.paneKey)
      ? card.paneKey
      : null
  return {
    ...card,
    cause: 'blocked',
    portalPaneKey: routable,
    // Why: the wait a person reads is how long the ask has been open, not the pane's last ping.
    stateChangedAt: run.requests[0]!.openedAt,
    run: {
      chainId: chain.id,
      sourceRowKey: chain.sourceRowKey,
      headline: run.headline,
      why: run.detail ?? '',
      requests: run.requests
    }
  }
}

/**
 * The one "needs you" list with pursued runs read through the run policy: a run's panes leave
 * it (a stopped, idle or silent worker is nobody's question) and each run with an open request
 * addressed to the owner enters it once, as "Needs you: <ask>". Ordinary conversations keep their
 * own live prompts untouched.
 */
export function withRunAttention(
  snapshot: AgentPaneSnapshot,
  chains: readonly SessionChain[],
  waiting: ReadonlySet<string>,
  now = Date.now()
): AgentPaneSnapshot {
  const readings: Reading[] = chains
    .filter((chain) => chain.outcomeSet && chain.state !== 'cancelled')
    .map((chain) => ({
      chain,
      run: sessionRunRowState(chain, {
        now,
        snoozed: waiting.has(waitLaterKeyForPane(chain.sourcePaneKey))
      })
    }))
  if (readings.length === 0) {
    return snapshot
  }
  const asked = new Map<string, AttentionPane>()
  for (const reading of readings) {
    if (reading.run.countsAsAttention) {
      const pane = requestPane(reading, snapshot.cardsByPaneKey)
      // Why: two runs asking through one pane are still one place to go; the older ask leads.
      if (!asked.has(pane.paneKey)) {
        asked.set(pane.paneKey, pane)
      }
    }
  }
  const own = snapshot.attention.filter(
    (pane) => !asked.has(pane.paneKey) && !readings.some((reading) => ownsPane(reading, pane))
  )
  if (asked.size === 0 && own.length === snapshot.attention.length) {
    return snapshot
  }
  const attention = [...own, ...asked.values()].sort(compareAttentionPanes)
  return {
    ...snapshot,
    attention,
    attentionByPaneKey: new Map(attention.map((pane) => [pane.paneKey, pane])),
    attentionWorktreeIds: new Set(attention.map((pane) => pane.worktreeId))
  }
}
