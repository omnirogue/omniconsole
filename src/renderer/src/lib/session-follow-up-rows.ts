import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useSessionFollowUpChains } from '@/lib/session-chain-registry'
import { sessionChainErrorMessage } from '@/lib/session-chain-error'
import { followUpExceptionMessage, followUpReadyText } from '@/lib/session-follow-up-messages'
import { sessionRunRowState } from '@/lib/session-run-row-state'
import type { WorkFollowUpRow, WorkFollowUpState } from '../../../shared/backoffice-work-views'
import { sessionFollowUpStep, type SessionChain } from '../../../shared/session-chain-types'
import { isSessionFollowUpDelivered } from '../../../shared/session-follow-up-rule'

/**
 * Saved follow-ups as the Waiting For projection reads them. The state comes from the
 * persisted rule only: "delivered" needs every person's acknowledged thread, and a
 * rule still waiting on its run never claims anyone received anything.
 */
export function sessionFollowUpState(chain: SessionChain): WorkFollowUpState | null {
  const step = sessionFollowUpStep(chain)
  if (!step) {
    return null
  }
  const rule = step.handoff
  if (step.status === 'delivered' || isSessionFollowUpDelivered(rule)) {
    return 'delivered'
  }
  if (chain.state === 'cancelled') {
    return 'cancelled'
  }
  if (chain.state === 'failed' || rule.exception) {
    return 'exception'
  }
  if (
    chain.state === 'launching' ||
    rule.capturedAt !== undefined ||
    [...rule.recipients, ...(rule.agentRecipients ?? [])].some(
      (recipient) => recipient.delivery !== 'pending'
    )
  ) {
    return 'delivering'
  }
  return 'waiting-for-run'
}

/** Stopped with every named file present: only the person's confirmation or a clean exit sends it. */
export function isSessionFollowUpReady(chain: SessionChain): boolean {
  const rule = sessionFollowUpStep(chain)?.handoff
  return (
    !!rule &&
    sessionFollowUpState(chain) === 'waiting-for-run' &&
    rule.readyAt !== undefined &&
    rule.confirmedAt === undefined
  )
}

export function sessionFollowUpRow(chain: SessionChain, now = Date.now()): WorkFollowUpRow | null {
  const step = sessionFollowUpStep(chain)
  const state = sessionFollowUpState(chain)
  if (!step || !state) {
    return null
  }
  const rule = step.handoff
  // Why: a failed or blocked rule is an exception row. It is the reader's move only while its
  // run holds an open request addressed to them, and then the row says that ask.
  const asked = chain.outcomeSet ? sessionRunRowState(chain, { now }).requests[0] : undefined
  const detail =
    state === 'exception'
      ? rule.exception
        ? followUpExceptionMessage(rule.exception)
        : sessionChainErrorMessage(chain.error)
      : isSessionFollowUpReady(chain)
        ? followUpReadyText()
        : state === 'waiting-for-run' && rule.waitingForFiles?.length
          ? translate('sessionFollowUp.waitingForFiles', 'Waiting for final files: {{names}}', {
              names: rule.waitingForFiles.join(', ')
            })
          : rule.agentRecipients?.length
            ? translate('nextStep.queuedAgentRecipients', 'To {{names}}', {
                names: rule.agentRecipients.map((agent) => agent.name).join(', ')
              })
            : null
  return {
    id: chain.id,
    taskId: rule.taskId,
    title: rule.taskTitle,
    recipientIds: rule.recipients.map((recipient) => recipient.employeeId),
    hasAgentRecipients: (rule.agentRecipients?.length ?? 0) > 0,
    action: rule.action ?? null,
    state,
    threadIds: rule.recipients
      .filter((recipient) => recipient.delivery === 'sent' && recipient.threadId)
      .map((recipient) => recipient.threadId!),
    detail,
    dueAt: rule.dueAt ?? null,
    updatedAt: new Date(chain.updatedAt).toISOString(),
    ...(asked ? { ask: asked.ask } : {})
  }
}

/** Every saved follow-up this computer knows, mapped for Needs You / Waiting For / All. */
export function useSessionFollowUpRows(): WorkFollowUpRow[] {
  const chains = useSessionFollowUpChains()
  return useMemo(
    () =>
      chains
        .map((chain) => sessionFollowUpRow(chain))
        .filter((row): row is WorkFollowUpRow => row !== null),
    [chains]
  )
}
