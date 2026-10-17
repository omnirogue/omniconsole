// The pane card's answer send, as a plain function so an answer that arrives from outside a
// mounted card (an OmniOS answer relayed by main) types through the very same path.
import { useAppStore } from '../../store'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  resolveAskAnswerKeyAgent,
  shouldStepNativeChatAskAnswer
} from '../../../../shared/native-chat-agent-support'
import { buildAgentAskAnswerKeys } from '../../../../shared/native-chat-ask-answer-keys'
import {
  formatAskAnswer,
  formatAsyncAskAnswer,
  hasAskAnswer,
  type AskAnswerSelection,
  type AskPrompt
} from './native-chat-interactive-prompt'
import {
  sendNativeChatAskAnswer,
  sendNativeChatMessage,
  type AskAnswerRefusal,
  type NativeChatSendHandle
} from './native-chat-runtime-send'
import { inferQuestionAnsweredFromCurrentStatus } from '../terminal-pane/agent-question-answered-inference'
import { sendProvenAgentQuestionAnswer } from './native-chat-proven-answer-send'
import { shownAsyncQuestions } from './async-question-dismissal'
import { asyncAskQuestionsLeftOut } from '../../../../shared/native-chat-ask'
import type { ShownAsyncQuestion } from '../../../../shared/codex-async-question-dismissal'
import { waitForClaudeAskSelectorClosed } from './native-chat-ask-screen'
import { optionOnlyAskScreenAgent } from '../../../../shared/option-only-ask-screen'
import { isOptionOnlyAskOnScreen, waitForOptionOnlyAskStep } from './option-only-ask-screen-wait'

const MESSAGE_ANSWER_SETTLE_GRACE_MS = 15_000

export type NativeChatAnswerTarget = {
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  agent: AgentType
  /** The pane's visible terminal text; confirms a Claude answer actually closed its selector. */
  readScreen: () => (() => string | null) | undefined
  /** The in-flight answer's cancel handle, shared with whoever may cancel it. */
  inFlight: { current: NativeChatSendHandle | null }
  cancelInFlight: () => void
}

/** Questions the card showed that this answer skips: passed over, and Codex drops them too. */
function leftOutOf(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): { leftOut?: ShownAsyncQuestion[] } {
  const leftOut = asyncAskQuestionsLeftOut(prompt, selections)
  return leftOut.length > 0 ? { leftOut: shownAsyncQuestions(leftOut) } : {}
}

export function sendNativeChatInteractiveAnswer(
  ctx: NativeChatAnswerTarget,
  prompt: AskPrompt,
  selections: AskAnswerSelection[],
  onDeliverySettled?: (delivered: boolean, refusal?: AskAnswerRefusal) => void
): { settleAfterMs: number; waitsForVerifiedDelivery: boolean } {
  const { terminalTabId, paneKey, agent } = ctx
  const targetPtyId = ctx.targetPtyId
  if (!targetPtyId || !hasAskAnswer(prompt, selections)) {
    return { settleAfterMs: 0, waitsForVerifiedDelivery: false }
  }
  // Selectors ignore pasted labels; OpenClaude follows Claude's path.
  // Why async answers go as a message: that is how the agent takes them (Codex's reply layout).
  const stepsAnswer = shouldStepNativeChatAskAnswer(agent, prompt)
  const keyAgent = resolveAskAnswerKeyAgent(agent)
  const answerKeys =
    stepsAnswer && keyAgent ? buildAgentAskAnswerKeys(keyAgent, prompt, selections) : []
  const screenAgent = optionOnlyAskScreenAgent(agent)
  // Why the screen: these agents send no hook when their dialog is cancelled, and Qwen shows
  // another tool's confirmation first; keys go only onto this question's own dialog.
  const offScreen =
    screenAgent !== null && !isOptionOnlyAskOnScreen(screenAgent, ctx.readScreen(), prompt)
  if ((stepsAnswer && answerKeys.length === 0) || offScreen) {
    // Why: a refused answer is never pasted as a message into a selector; the card stays.
    if (offScreen && answerKeys.length > 0) {
      onDeliverySettled?.(false, 'not-on-screen')
    } else {
      onDeliverySettled?.(false)
    }
    return { settleAfterMs: 0, waitsForVerifiedDelivery: false }
  }
  // Cancel any prior in-flight answer before starting a new one.
  ctx.cancelInFlight()
  const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId)
  // Why: pin the answered question's baseline BEFORE delivery. A late settle
  // callback (paced writes + remote acceptance can span seconds on SSH) must
  // not read the live status and mint a fresh baseline for a replacement
  // question that became current meanwhile — that would clear the new
  // question's wait. The server re-validates this captured baseline and
  // rejects a changed status, matching the terminal keystroke path.
  const questionStatusBaseline = stepsAnswer
    ? useAppStore.getState().agentStatusByPaneKey[paneKey]
    : undefined
  let settledHandle: NativeChatSendHandle | null = null
  let cancelled = false
  let stopScreenCheck: () => void = () => {}
  const finish = (delivered: boolean, refusal?: AskAnswerRefusal): void => {
    if (settledHandle && ctx.inFlight.current === settledHandle) {
      // Why: a completed verified send otherwise retains its timers,
      // promises, and prompt callback until the next send or unmount.
      ctx.inFlight.current = null
    }
    if (delivered) {
      inferQuestionAnsweredFromCurrentStatus({
        paneKey,
        getStatusEntry: () => questionStatusBaseline,
        inferQuestionAnswered: (request) =>
          window.api.agentStatus.inferQuestionAnswered(request).catch((err) => {
            console.warn('[agent-question] native-chat inference failed:', err)
            return false
          })
      })
    }
    if (!delivered && refusal) {
      onDeliverySettled?.(false, refusal)
    } else {
      onDeliverySettled?.(delivered)
    }
  }
  const onSettled = stepsAnswer
    ? (delivered: boolean, refusal?: AskAnswerRefusal): void => {
        if (!delivered || keyAgent !== 'claude') {
          finish(delivered, refusal)
          return
        }
        // Why: the PTY accepting the keys is not Claude taking the answer. Marking
        // it answered on acceptance hid the card and showed the agent working while
        // the terminal still waited on the selector; keep the card retryable instead.
        stopScreenCheck = waitForClaudeAskSelectorClosed({
          prompt,
          readScreen: ctx.readScreen(),
          isCancelled: () => cancelled,
          onResult: finish
        })
      }
    : undefined
  const sent: NativeChatSendHandle = stepsAnswer
    ? screenAgent
      ? sendNativeChatAskAnswer(settings, targetPtyId, answerKeys, onSettled, (group) =>
          waitForOptionOnlyAskStep({
            agent: screenAgent,
            prompt,
            group,
            readScreen: ctx.readScreen(),
            isCancelled: () => cancelled
          })
        )
      : sendNativeChatAskAnswer(settings, targetPtyId, answerKeys, onSettled)
    : prompt.delivery === 'async'
      ? // Why the host's proven door: the question can outlive the agent, and this message
        // typed into a shell would run as a command.
        sendProvenAgentQuestionAnswer({
          ptyId: targetPtyId,
          paneKey,
          text: formatAsyncAskAnswer(prompt, selections),
          ...leftOutOf(prompt, selections)
        })
      : sendNativeChatMessage(settings, targetPtyId, formatAskAnswer(prompt, selections))
  let onMessageCancelled: () => void = () => {}
  const handle: NativeChatSendHandle = {
    ...sent,
    cancel: () => {
      cancelled = true
      stopScreenCheck()
      sent.cancel()
      onMessageCancelled()
    }
  }
  // Why: native-chat answer writes bypass xterm.onData. Infer only after
  // every paced selector write has fired, so an early digit in a multi-step
  // answer cannot dismiss the wait or cancel the remaining writes.
  settledHandle = handle
  ctx.inFlight.current = handle
  // Why: a queued message's Enter can land after the nominal settle time; cancelling then drops it.
  // Why async only: other agents' message answers keep their fixed settle window.
  const messageSettled = prompt.delivery === 'async' ? sent.settled : undefined
  if (messageSettled) {
    let reported = false
    let confirming = false
    // Why a deadline: a queue that never settles must not leave the card submitting forever.
    const deadline = setTimeout(() => {
      // Why confirm: reopen the card only once the host proves the answer never landed.
      confirming = true
      const confirm =
        sent.cancelAndConfirm?.() ??
        Promise.resolve().then(() => {
          sent.cancel()
          return sent.wasSubmitted?.() ?? false
        })
      void confirm.then(report, () => report(false))
    }, handle.settleAfterMs + MESSAGE_ANSWER_SETTLE_GRACE_MS)
    const report = (delivered: boolean): void => {
      if (reported) {
        return
      }
      reported = true
      clearTimeout(deadline)
      if (ctx.inFlight.current === handle) {
        ctx.inFlight.current = null
      }
      onDeliverySettled?.(delivered)
    }
    onMessageCancelled = () => report(false)
    void messageSettled.then(() => {
      if (!cancelled && !confirming) {
        report(sent.wasSubmitted?.() ?? true)
      }
    })
  }
  return {
    settleAfterMs: handle.settleAfterMs,
    waitsForVerifiedDelivery: onSettled !== undefined || messageSettled !== undefined
  }
}
