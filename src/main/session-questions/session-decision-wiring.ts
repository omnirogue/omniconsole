/**
 * Starts the Work box's durable question list on this host: the hook server's status stream feeds
 * `SessionDecisionStore`, pane teardown marks a waiting question ended instead of losing it, and
 * each question gets one JEV reading when the box first lists it.
 */

import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { parseAskFromStatus } from '../../shared/native-chat-ask'
import type { SessionDecision, SessionDecisionRecord } from '../../shared/session-decisions'
import { pendingSessionAsk } from '../../shared/session-questions'
import { agentHookServer } from '../agent-hooks/server'
import { createSessionDecisionScorer, type SessionDecisionScorer } from './session-decision-jev'
import { SessionDecisionStore } from './session-decision-store'

/** A failed reading is asked again after this long, never on every refresh. */
const RETRY_SCORE_AFTER_MS = 10 * 60 * 1000

let active: {
  store: SessionDecisionStore
  score: (record: SessionDecisionRecord) => void
} | null = null

export function getSessionDecisionStore(): SessionDecisionStore | null {
  return active?.store ?? null
}

/** A status row already open at startup, as the event the store reads (it was asked before). */
function snapshotEvent(status: AgentStatusIpcPayload): AgentHookEventPayload {
  const toolUseId = agentHookServer.getToolUseIdForPane(status.paneKey)
  return {
    paneKey: status.paneKey,
    connectionId: status.connectionId ?? null,
    ...(status.worktreeId ? { worktreeId: status.worktreeId } : {}),
    ...(status.providerSession ? { providerSession: status.providerSession } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(status.providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...(status.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    payload: status
  } as AgentHookEventPayload
}

export function startSessionDecisions(options: {
  userDataPath: string
  scorer?: SessionDecisionScorer
}): () => Promise<void> {
  const scorer = options.scorer ?? createSessionDecisionScorer()
  const store = new SessionDecisionStore({
    directory: options.userDataPath,
    // Why: only a live, confirmed status counts; a restored or identity-only row proves nothing.
    paneStillAsking: (paneKey, interactivePrompt) =>
      agentHookServer
        .getStatusSnapshotForPane(paneKey)
        .some(
          (status) =>
            !status.providerSessionOnly &&
            !status.restoredUnconfirmed &&
            status.interactivePrompt === interactivePrompt &&
            pendingSessionAsk(status) !== null
        )
  })
  store.load()
  for (const status of agentHookServer.getStatusSnapshot()) {
    if (pendingSessionAsk(status)) {
      store.observe(snapshotEvent(status), status.stateStartedAt)
    }
  }
  const scoring = new Set<string>()
  const score = (record: SessionDecisionRecord): void => {
    const failedRecently =
      record.scoreFailure && Date.now() - record.scoreFailure.at < RETRY_SCORE_AFTER_MS
    if (record.scores || failedRecently || scoring.has(record.key)) {
      return
    }
    scoring.add(record.key)
    void scorer(record, null)
      .then((result) =>
        'failed' in result
          ? store.setScores(record.key, null, result.failed)
          : store.setScores(record.key, result, null)
      )
      .catch((error: unknown) =>
        store.setScores(record.key, null, error instanceof Error ? error.message : String(error))
      )
      .finally(() => scoring.delete(record.key))
  }
  const unsubscribes = [
    agentHookServer.subscribeEnrichedStatus((event) => store.observe(event)),
    agentHookServer.subscribePaneStatusClear((clear) => {
      if ('paneKey' in clear) {
        store.markPaneEnded(clear.paneKey)
      }
    }),
    agentHookServer.subscribeStatusDrop((paneKey) => store.markPaneEnded(paneKey))
  ]
  active = { store, score }
  return async () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
    active = null
    await store.flush()
  }
}

/** Everything the box lists, oldest ask first; unread questions get their JEV reading started. */
export function listSessionDecisions(options: { score?: boolean } = {}): SessionDecision[] {
  if (!active) {
    return []
  }
  const decisions: SessionDecision[] = []
  for (const record of active.store.list()) {
    const ask = parseAskFromStatus(record.interactivePrompt, record.toolName ?? undefined)
    if (!ask || ask.questions.length === 0) {
      continue
    }
    // Why optional: background readers (the OmniOS sync) must not start JEV readings on their own.
    if (options.score !== false) {
      active.score(record)
    }
    const { scoreFailure, ...rest } = record
    decisions.push({
      ...rest,
      title: null,
      questions: ask.questions,
      scoreUnavailable: record.scores ? null : (scoreFailure?.reason ?? null)
    })
  }
  return decisions.toSorted((left, right) => left.askedAt - right.askedAt)
}
