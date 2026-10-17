import { HANDOFF_FILE_MAX_BYTES, type ExactHandoffFile } from './console-handoff-contract'
import { chatAgentSend } from './console-chat-agent-contract'
import {
  FollowUpException,
  errorText,
  type FollowUpDeliveryContext
} from './session-follow-up-delivery-contract'
import type { SessionFollowUpRule } from './session-follow-up-rule'

/** Resolve an employee's chosen live endpoint before any send; no employee-owner fallback. */
export async function requireFollowUpAgentEndpoints(
  ctx: FollowUpDeliveryContext,
  rule: SessionFollowUpRule
): Promise<void> {
  if (!rule.agentRecipients?.length) {
    return
  }
  if (!ctx.hub.agentRecipients || !ctx.hub.sendAgent) {
    throw new FollowUpException(
      'rejected',
      'Agent recipient',
      'Update this execution host to deliver to an existing agent session.'
    )
  }
  const directory = await ctx.hub.agentRecipients()
  for (const recipient of rule.agentRecipients.filter((entry) => entry.delivery === 'pending')) {
    if (
      !directory.agents.some(
        (agent) =>
          agent.id === recipient.id &&
          agent.employeeId === recipient.employeeId &&
          agent.projectId === recipient.projectId
      )
    ) {
      throw new FollowUpException(
        'rejected',
        recipient.name,
        'The selected agent session is no longer available. Choose an active agent session before sending.'
      )
    }
  }
  if (new TextEncoder().encode(rule.note).length > 8192) {
    throw new FollowUpException(
      'rejected',
      'Message',
      'The agent message exceeds 8,192 UTF-8 bytes. Shorten it before sending.'
    )
  }
}

export async function deliverFollowUpAgents(
  ctx: FollowUpDeliveryContext,
  attachments: ExactHandoffFile[]
): Promise<'delivered' | 'stopped'> {
  const start = ctx.current()
  if (!start) {
    return 'stopped'
  }
  if (!start.agentRecipients?.length) {
    return 'delivered'
  }
  if (attachments.reduce((sum, file) => sum + file.size, 0) > HANDOFF_FILE_MAX_BYTES) {
    throw new FollowUpException(
      'file-too-large',
      'Agent attachments',
      'An agent handoff supports up to 10 MiB of attachments in total.'
    )
  }
  for (const target of start.agentRecipients) {
    if (target.delivery === 'sent') {
      continue
    }
    const patch = async (fields: Partial<typeof target>): Promise<void> => {
      const rule = ctx.current()
      if (!rule) {
        return
      }
      await ctx.save({
        ...rule,
        agentRecipients: rule.agentRecipients?.map((recipient) =>
          recipient.id === target.id ? { ...recipient, ...fields } : recipient
        )
      })
    }
    const input = chatAgentSend.parse({
      recipientSessionId: target.id,
      sourceConversationId: start.sourceConversationId,
      sourceLabel: utf8Label(start.sessionLabel),
      message: start.note,
      communicationType: start.communicationType ?? 'information',
      attachments,
      operationId: target.operationId
    })
    if (!ctx.current()) {
      return 'stopped'
    }
    await patch({ delivery: 'sending', at: ctx.now(), error: undefined })
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        await ctx.sleep(attempt === 1 ? 2000 : 5000)
      }
      if (!ctx.current()) {
        return 'stopped'
      }
      try {
        const receipt = await ctx.hub.sendAgent!(input)
        if (
          receipt.recipientSessionId !== target.id ||
          !/^pm_[a-f0-9]{24}$/.test(receipt.messageId)
        ) {
          throw new Error('The agent delivery did not verify the selected recipient session.')
        }
        await patch({
          delivery: 'sent',
          messageId: receipt.messageId,
          receiptState: receipt.state,
          at: ctx.now(),
          error: undefined
        })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (ctx.hub.isRejected(error)) {
          await patch({ delivery: 'failed', error: errorText(error) })
          throw new FollowUpException('rejected', target.name, errorText(error))
        }
      }
    }
    if (lastError) {
      await patch({ delivery: 'sending', error: errorText(lastError) })
      throw new FollowUpException('unconfirmed', target.name, errorText(lastError))
    }
  }
  return 'delivered'
}
function utf8Label(label: string): string {
  let value = ''
  for (const character of label) {
    if (new TextEncoder().encode(value + character).length > 160) {
      break
    }
    value += character
  }
  return value || 'Session'
}
