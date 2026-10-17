/**
 * Chat sends that go through the host's per-session input queue.
 *
 * The clear, the framed body and Enter leave here as ONE item, so the submit gap
 * is the host's business: no renderer timer is left to fire at a PTY this pane has
 * since stopped owning, and a chain step's paste or a worker's prompt cannot land
 * between this send's bytes.
 *
 * The item is still taken from inside the per-PTY chat queue, because chat's other
 * write paths (typed slash commands, question answers, image attachments) observe
 * the terminal between writes and cannot be expressed as one item — chat keeps one
 * ordering domain of its own, and the host queue orders it against everything else.
 */

import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import {
  buildSessionInputProgram,
  isSessionInputDeliveredStatus
} from '../../../../shared/session-input-program'
import {
  cancelRuntimeSessionInput,
  submitRuntimeSessionInput
} from '@/runtime/runtime-session-input'
import {
  buildNativeChatSubmitParts,
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
} from './native-chat-send'
import type { NativeChatSendHandle, NativeChatSendOptions } from './native-chat-send-contract'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'

let nextChatSendSequence = 1

/** One id per send attempt, so a repeat of THIS attempt replays instead of retyping. */
export function nextNativeChatClientMessageId(): string {
  return `chat:${Date.now()}:${nextChatSendSequence++}`
}

/**
 * Build the atomic program for a chat send. `confirmCleared` becomes a
 * clear-confirm step: the host cannot read this pane's input line, so it widens to
 * the maximal clear burst — the branch the pane itself takes when its own probe
 * cannot answer, and a measured no-op on a line that is already empty.
 */
export function buildNativeChatSessionInputProgram(
  text: string,
  options?: NativeChatSendOptions
): ReturnType<typeof buildSessionInputProgram> {
  const parts = buildNativeChatSubmitParts(text, options?.agent)
  return buildSessionInputProgram({
    clearInput: options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
    ...(options?.confirmCleared
      ? {
          clearConfirm: {
            afterMs: NATIVE_CHAT_CLEAR_CONFIRM_MS,
            widenTo: AGENT_TUI_CLEAR_INPUT_MAX
          }
        }
      : {}),
    body: parts.body,
    submitDelayMs: NATIVE_CHAT_SUBMIT_DELAY_MS,
    submit: parts.submit
  })
}

export function sendNativeChatMessageThroughSessionQueue(
  ptyId: string,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  const clientMessageId = nextNativeChatClientMessageId()
  const program = buildNativeChatSessionInputProgram(text, options)
  let delivered = false
  const handle = enqueueNativeChatPtySend(
    ptyId,
    NATIVE_CHAT_SUBMIT_DELAY_MS + (options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0),
    ({ isCancelled, markSubmitted }) => {
      if (isCancelled()) {
        markSubmitted()
        return
      }
      void submitRuntimeSessionInput({
        ptyId,
        clientMessageId,
        origin: 'chat',
        body: text,
        ...(options?.force ? { force: true } : {}),
        program
      }).then((receipt) => {
        // Why only a real delivery counts as submitted: a refused duplicate wrote
        // nothing, and the text it repeats is already on its way from the first
        // item. Releasing the chat queue's turn is unconditional either way.
        delivered = receipt !== null && isSessionInputDeliveredStatus(receipt.status)
        markSubmitted()
      })
    },
    {
      onCancelUnsubmitted: () => {
        // Why by id: another origin's item, or a later chat send, keeps its turn.
        void cancelRuntimeSessionInput(ptyId, { clientMessageId })
      }
    }
  )
  return { ...handle, wasSubmitted: () => delivered }
}
