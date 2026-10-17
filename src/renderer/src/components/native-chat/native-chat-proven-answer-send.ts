/**
 * A message answer to an agent's async question (pane card, Needs you), handed to the host that
 * owns the terminal as one item. The host writes it only while it proves the agent holds that
 * terminal (`agent-question-message-answer.ts`): the question can outlive the agent, and the same
 * message in a shell would run as a command. Where no such proof can be asked for (a remote
 * runtime's pane, a client without the door) nothing is sent.
 */

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { cancelRuntimeSessionInputVerified } from '@/runtime/runtime-session-input'
import type {
  AgentQuestionAnswerOutcome,
  AgentQuestionAnswerRequest
} from '../../../../shared/agent-question-answer-contract'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { NativeChatSendHandle } from './native-chat-send-contract'
import { nextNativeChatClientMessageId } from './native-chat-session-input-send'

type AnswerApi = (request: AgentQuestionAnswerRequest) => Promise<AgentQuestionAnswerOutcome>

function answerApi(): AnswerApi | null {
  const api = (globalThis as { window?: { api?: { pty?: { answerAgentQuestion?: AnswerApi } } } })
    .window?.api?.pty?.answerAgentQuestion
  return typeof api === 'function' ? api : null
}

const RECEIPT_AFTER_CANCEL_MS = 5_000

export function sendProvenAgentQuestionAnswer(
  input: Omit<AgentQuestionAnswerRequest, 'clientMessageId'>
): NativeChatSendHandle {
  const clientMessageId = nextNativeChatClientMessageId()
  const api = answerApi()
  const request = api && parseRemoteRuntimePtyId(input.ptyId) === null ? api : null
  const outcome: Promise<AgentQuestionAnswerOutcome> = request
    ? request({ ...input, clientMessageId }).catch(() => ({
        status: 'not-sent' as const,
        reason: translate(
          'needsYou.answerNotHandedOver',
          'The answer could not be handed over. Nothing was sent.'
        )
      }))
    : Promise.resolve({
        status: 'not-sent' as const,
        reason: translate(
          'needsYou.answerNeedsTerminal',
          'This terminal cannot prove its agent is still running, so nothing was sent. Answer it in the terminal.'
        )
      })
  let delivered = false
  const settled = outcome.then((result) => {
    // Why unconfirmed counts: some of it may have landed, and a second copy would answer twice.
    delivered = result.status !== 'not-sent'
    if (result.status !== 'delivered') {
      toast.message(result.reason)
    }
  })
  return {
    settleAfterMs: NATIVE_CHAT_SUBMIT_DELAY_MS,
    settled,
    wasSubmitted: () => delivered,
    cancel: () => {
      void cancelRuntimeSessionInputVerified(input.ptyId, { clientMessageId })
    },
    cancelAndConfirm: async () => {
      // Why verified: once the host confirms, no further byte of this answer can land.
      await cancelRuntimeSessionInputVerified(input.ptyId, { clientMessageId })
      await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(resolve, RECEIPT_AFTER_CANCEL_MS))
      ])
      return delivered
    }
  }
}
