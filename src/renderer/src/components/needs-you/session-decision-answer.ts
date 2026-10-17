/**
 * How the Work box's answer reaches the session that asked, chosen at the moment of answering:
 *
 * - `keys`   — the agent still waits on this exact question in a live terminal: the pane's own
 *              question card path (selector keystrokes), guarded like Needs you's rows.
 * - `message` — the conversation was already resumed elsewhere and is live again: the answer goes
 *              to that pane's prompt queue as the person's next message.
 * - `resume` — nothing live holds the conversation: resume it in a new background tab and queue
 *              the answer as its first message once the agent is ready. Only from the app's own
 *              sleeping record (the agent is known to have exited) or once its terminal is gone.
 * - `unreachable` — nothing to resume (no provider session, workspace or agent), or its terminal
 *              is still open without a live question (the agent may still run there, and right
 *              after a restart its status can lag its terminal): open it.
 *
 * Why the pane that asked comes first: while it is open the answer belongs in it, never in a
 * queue for another pane or a resumed copy. A restart leaves a `quit`/`live` sleeping record on
 * each agent pane it restores; that record means "this pane still exists", never "the agent
 * exited", so it must not start a copy of the conversation.
 */

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { launchSleepingAgentSession } from '@/lib/sleeping-agent-session-launch'
import { enqueuePromptOnce } from '@/components/prompt-queue/use-prompt-queue'
import { useAppStore } from '@/store'
import {
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { formatAskAnswer, type AskAnswerSelection } from '../../../../shared/native-chat-ask'
import type { AskPrompt } from '../../../../shared/native-chat-ask-types'
import {
  SESSION_DECISIONS_RPC,
  answerAfterSessionEnded,
  type SessionDecision
} from '../../../../shared/session-decisions'
import { pendingSessionAsk } from '../../../../shared/session-questions'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'

type StoreState = ReturnType<typeof useAppStore.getState>

export type DecisionDelivery =
  | { kind: 'keys'; tabId: string; ptyId: string }
  | { kind: 'message'; worktreeId: string; paneKey: string }
  | { kind: 'resume'; record: SleepingAgentSessionRecord }
  | { kind: 'unreachable' }

function livePtyId(state: StoreState, paneKey: string): { tabId: string; ptyId: string } | null {
  const owner = parsePaneKey(paneKey)
  const ptyId = owner
    ? state.terminalLayoutsByTabId[owner.tabId]?.ptyIdsByLeafId?.[owner.leafId]
    : undefined
  return owner && ptyId ? { tabId: owner.tabId, ptyId } : null
}

function resumeRecord(
  state: StoreState,
  decision: SessionDecision
): SleepingAgentSessionRecord | null {
  // Why first: with its terminal still open the agent may still be running there, whatever record
  // exists; a second process on the same conversation must never be started from here.
  if (livePtyId(state, decision.paneKey)) {
    return null
  }
  const sessionId = decision.providerSession?.id
  const own = state.sleepingAgentSessionsByPaneKey[decision.paneKey]
  const records = [
    ...(own ? [own] : []),
    ...(sessionId
      ? Object.values(state.sleepingAgentSessionsByPaneKey).filter(
          (record) => record !== own && record.providerSession.id === sessionId
        )
      : [])
  ]
  // Why: a quit/live record describes a pane that still exists; only that pane's own restore may
  // resume it, so the conversation still has a home and nothing here may start a copy.
  if (records.some((record) => record.origin === 'quit' || record.origin === 'live')) {
    return null
  }
  if (records[0]) {
    return records[0]
  }
  if (!decision.providerSession || !decision.worktreeId || !isResumableTuiAgent(decision.agent)) {
    return null
  }
  const now = Date.now()
  return {
    paneKey: decision.paneKey,
    worktreeId: decision.worktreeId,
    agent: decision.agent,
    providerSession: decision.providerSession,
    prompt: '',
    state: 'waiting',
    capturedAt: decision.endedAt ?? now,
    updatedAt: now
  }
}

export function decisionDelivery(state: StoreState, decision: SessionDecision): DecisionDelivery {
  const status = state.agentStatusByPaneKey[decision.paneKey]
  const live = livePtyId(state, decision.paneKey)
  if (
    live &&
    status &&
    pendingSessionAsk(status) &&
    status.interactivePrompt === decision.interactivePrompt
  ) {
    return { kind: 'keys', ...live }
  }
  if (live && decision.endedAt === null) {
    // Why: the pane that asked is still open and its asker never ended (a resume there ends it:
    // SessionStart), so it may wait on the question; its status can lag right after a restart,
    // and a child's activity is not the asker's. The person answers in it; a queued message would
    // only land after the question, never in it.
    return { kind: 'unreachable' }
  }
  const sessionId = decision.providerSession?.id
  if (sessionId) {
    for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
      const worktreeId = entry.worktreeId ?? decision.worktreeId
      if (entry.providerSession?.id === sessionId && worktreeId && livePtyId(state, paneKey)) {
        return { kind: 'message', worktreeId, paneKey }
      }
    }
  }
  const record = resumeRecord(state, decision)
  return record ? { kind: 'resume', record } : { kind: 'unreachable' }
}

async function resolveDecision(key: string): Promise<void> {
  await callRuntimeRpc({ kind: 'local' }, SESSION_DECISIONS_RPC.resolve, {
    key
  }).catch(() => {})
}

/**
 * Deliver an answer the pane cannot take as keystrokes: queue it to the live resumed pane, or
 * resume the conversation in a background tab and queue it there. Resolves true once queued.
 */
export async function deliverDecisionAsMessage(
  decision: SessionDecision,
  delivery: Extract<DecisionDelivery, { kind: 'message' | 'resume' }>,
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): Promise<boolean> {
  const text = answerAfterSessionEnded(prompt.questions, formatAskAnswer(prompt, selections))
  if (delivery.kind === 'message') {
    await enqueuePromptOnce(
      {
        worktreeId: delivery.worktreeId,
        paneKey: delivery.paneKey,
        kind: 'pty'
      },
      text
    )
    await resolveDecision(decision.key)
    return true
  }
  const pending: { queued?: Promise<unknown> } = {}
  const launched = launchSleepingAgentSession(delivery.record, {
    suppressNavigation: true,
    onSessionLaunched: (tabId) => {
      const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      const leafId = layout?.root?.type === 'leaf' ? layout.root.leafId : layout?.activeLeafId
      if (leafId) {
        // Why the queue: it delivers once the resumed agent reads as free, never into its startup.
        pending.queued = enqueuePromptOnce(
          {
            worktreeId: delivery.record.worktreeId,
            paneKey: makePaneKey(tabId, leafId),
            kind: 'pty'
          },
          text
        )
      }
    }
  })
  if (!launched || !pending.queued) {
    return false
  }
  await pending.queued
  await resolveDecision(decision.key)
  return true
}
