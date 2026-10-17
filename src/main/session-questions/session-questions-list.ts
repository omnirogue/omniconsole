/**
 * The questions sessions on this computer wait on, from the hook server's latest status per pane
 * (`omni session questions`). Oldest first: the one waiting longest is the most urgent. One
 * conversation showing the same question in several panes (a duplicate resume) is listed once,
 * under the pane that has waited longest.
 */

import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  pendingSessionAsk,
  sessionQuestionIdentity,
  type PendingSessionQuestion
} from '../../shared/session-questions'

export function listPendingSessionQuestions(
  statuses: readonly AgentStatusIpcPayload[],
  toolUseIdOf: (paneKey: string) => string | undefined,
  titleOf: (paneKey: string) => string | null
): PendingSessionQuestion[] {
  const found: PendingSessionQuestion[] = []
  const byIdentity = new Map<string, PendingSessionQuestion>()
  for (const status of statuses) {
    const ask = pendingSessionAsk(status)
    if (!ask) {
      continue
    }
    const question: PendingSessionQuestion = {
      paneKey: status.paneKey,
      title: titleOf(status.paneKey),
      agent: status.agentType ?? null,
      askedAt: status.stateStartedAt,
      toolUseId: toolUseIdOf(status.paneKey) ?? null,
      sessionId: status.providerSession?.id ?? null,
      questions: ask.questions,
      ...(ask.delivery ? { delivery: ask.delivery } : {})
    }
    const identity = sessionQuestionIdentity(status)
    if (!identity) {
      found.push(question)
      continue
    }
    const listed = byIdentity.get(identity)
    if (!listed) {
      byIdentity.set(identity, question)
      found.push(question)
      continue
    }
    // Why the earlier one: it is the pane that asked; a later copy came from resuming the
    // conversation elsewhere, and a restored copy carries no process of its own.
    if (
      question.askedAt < listed.askedAt ||
      (question.askedAt === listed.askedAt && !listed.toolUseId && !!question.toolUseId)
    ) {
      found[found.indexOf(listed)] = question
      byIdentity.set(identity, question)
    }
  }
  return found.toSorted((left, right) => left.askedAt - right.askedAt)
}
