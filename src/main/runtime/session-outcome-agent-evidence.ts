import type { ConsoleHandoffApi } from '../../shared/console-handoff-contract'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { SessionOutcomeVerification } from './session-outcome-evidence'

let reader: Pick<ConsoleHandoffApi, 'getAgentMessage' | 'agentMessageFiles'> | null = null
export function installSessionOutcomeAgentReader(value: NonNullable<typeof reader>): void {
  reader = value
}

/** Only the selected agent's actual delivery and exact attachment receipts finish this condition. */
export async function verifySessionOutcomeAgentDelivery(
  condition: SessionOutcomeCondition,
  chain?: SessionChain
): Promise<SessionOutcomeVerification> {
  const step = chain?.steps.find(
    (entry) =>
      entry.kind === 'handoff' &&
      entry.handoff.agentRecipients?.some(
        (agent) =>
          agent.id === condition.recipientSessionId && agent.employeeId === condition.recipientId
      )
  )
  const rule = step?.kind === 'handoff' ? step.handoff : undefined
  const agent = rule?.agentRecipients?.find((entry) => entry.id === condition.recipientSessionId)
  if (!reader || !rule || !agent?.messageId || agent.delivery !== 'sent') {
    return {
      verified: false,
      reason: 'The selected agent session has no verified delivery receipt yet.'
    }
  }
  const result = await reader.getAgentMessage({ messageId: agent.messageId })
  if (!result.ok) {
    return { verified: false, reason: result.error.message }
  }
  const thread = result.data.thread
  if (
    thread.id !== agent.messageId ||
    thread.recipient_session_id !== agent.id ||
    thread.recipient_employee_id !== agent.employeeId ||
    thread.project_id !== agent.projectId ||
    thread.summary !== rule.note ||
    thread.communication_type !== (rule.communicationType ?? 'information')
  ) {
    return {
      verified: false,
      reason: 'The agent receipt does not match the selected recipient and message.'
    }
  }
  if (
    !['delivered', 'replied', 'resolved'].includes(thread.state) ||
    thread.delivered_at === null
  ) {
    return {
      verified: false,
      reason: 'The message is queued; the selected agent has not received it yet.'
    }
  }
  const files = await reader.agentMessageFiles({ messageId: agent.messageId })
  if (!files.ok) {
    return { verified: false, reason: files.error.message }
  }
  const pins = rule.files ?? []
  if (
    files.data.message_id !== agent.messageId ||
    files.data.files.length !== pins.length ||
    pins.some(
      (pin) =>
        !files.data.files.some(
          (file) => file.name === pin.name && file.sha256 === pin.sha256 && file.size === pin.size
        )
    )
  ) {
    return {
      verified: false,
      reason: 'The agent receipt does not expose the requested exact file versions.'
    }
  }
  return {
    verified: true,
    receipt: `agent-handoff:${agent.messageId}:${agent.id}:${thread.delivered_at}`
  }
}
