import type { AgentJournalSnapshot } from './agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from './structured-agent-session-projection'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'

export type StructuredAgentSessionOutcomeObservation = {
  ready: boolean
  version?: string
  reason?: string
  unverifiable?: boolean
}

export function observeStructuredAgentSessionOutcome(
  snapshot: AgentJournalSnapshot
): StructuredAgentSessionOutcomeObservation {
  const latest = snapshot.submissions.at(-1)
  if (!latest) {
    return { ready: false, reason: 'The source session has no submitted turn.' }
  }
  if (latest.dispatchState !== 'accepted' || !latest.providerItemId) {
    return {
      ready: false,
      ...(latest.dispatchState === 'pending' ? {} : { unverifiable: true }),
      reason: 'The latest source turn has no confirmed admission receipt.'
    }
  }
  if (
    snapshot.items.some(
      ({ body }) =>
        (body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending'
    )
  ) {
    return { ready: false, reason: 'The source agent needs your input.' }
  }
  const settled = snapshot.items.findLast(
    ({ body }) =>
      body.kind === 'status' &&
      body.turnLifecycle?.state === 'completed' &&
      body.turnLifecycle.settlement?.providerItemId === latest.providerItemId
  )
  const settlement =
    settled?.body.kind === 'status' ? settled.body.turnLifecycle?.settlement : undefined
  // Steering submissions share the initiating turn's unanswered-input boundary.
  const turnId = settled?.body.kind === 'status' ? settled.body.turnLifecycle?.turnId : undefined
  const receipts = new Set([latest.providerItemId])
  if (turnId) {
    for (const { body } of snapshot.items) {
      if (
        body.kind === 'status' &&
        body.turnLifecycle?.turnId === turnId &&
        body.turnLifecycle.settlement
      ) {
        receipts.add(body.turnLifecycle.settlement.providerItemId)
      }
    }
  }
  const sourceIds = new Set(
    snapshot.submissions
      .filter((submission) => submission.providerItemId && receipts.has(submission.providerItemId))
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const sourceSequence = snapshot.items.find((item) => sourceIds.has(item.itemId))?.sequence
  if (
    snapshot.items.some(
      ({ body, sequence }) =>
        body.kind === 'status' &&
        body.inputBlocked &&
        ((body.inputBlocked.providerItemId !== null &&
          receipts.has(body.inputBlocked.providerItemId)) ||
          (body.inputBlocked.providerItemId === null &&
            (sourceSequence === undefined || sequence >= sourceSequence)))
    )
  ) {
    return { ready: false, reason: 'The source turn ended with an unanswered input request.' }
  }
  if (
    snapshot.items.some(
      ({ body, sequence }) =>
        (body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'cancelled' &&
        (sourceSequence === undefined || sequence >= sourceSequence)
    )
  ) {
    return { ready: false, reason: 'The source turn ended with cancelled input.' }
  }
  if (activeStructuredAgentSessionTurnId(snapshot.items)) {
    return { ready: false }
  }
  if (settlement?.outcome === 'succeeded') {
    return {
      ready: true,
      version: JSON.stringify([
        snapshot.sessionId,
        latest.clientMessageId,
        latest.providerItemId,
        settlement.outcome
      ])
    }
  }
  if (settlement?.outcome === 'failed' || settlement?.outcome === 'cancelled') {
    return {
      ready: false,
      reason:
        settled?.body.kind === 'status' && settled.body.text
          ? settled.body.text
          : 'The latest source turn did not finish successfully.'
    }
  }
  return {
    ready: false,
    unverifiable: true,
    reason: 'The latest source turn has no verified successful completion.'
  }
}
