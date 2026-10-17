import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { pendingSessionAsk } from '../../../../shared/session-questions'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isClaudeAskSelectorOpen } from '../native-chat/native-chat-ask-screen'
import { isOptionOnlyAskOnScreen } from '../native-chat/option-only-ask-screen-wait'
import { optionOnlyAskScreenAgent } from '../../../../shared/option-only-ask-screen'
import type { AskPrompt } from '../native-chat/native-chat-interactive-prompt'
import type { NativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'

/** What an answer from outside the pane checks just before it types anything. */
export type QuestionAnswerContext = {
  paneKey: string
  ptyId: string
  /** The status the row showed the question from. */
  baseline: AgentStatusEntry
  readStatus: () => AgentStatusEntry | undefined
  readPtyId: () => string | null | undefined
  readScreen?: () => string | null
  /** Known only from an old or restored report: nothing is typed unless the screen shows it. */
  confirmOnScreen?: boolean
}

/** `gone`: answered elsewhere or the turn moved on; `not-on-screen`: pending, but its dialog is not
 *  visible in the terminal (cancelled there, covered, or unreadable), so no key may go. */
export type QuestionPendingState = 'pending' | 'gone' | 'not-on-screen'

/**
 * Still the question the row shows, on the same terminal, and (for Claude, when its screen can be
 * read) its selector still open: otherwise it was answered elsewhere or the turn moved on.
 */
export function questionStillPending(context: QuestionAnswerContext, prompt: AskPrompt): boolean {
  return questionPendingState(context, prompt) === 'pending'
}

export function questionPendingState(
  context: QuestionAnswerContext,
  prompt: AskPrompt
): QuestionPendingState {
  const current = context.readStatus()
  const { baseline } = context
  if (
    !current ||
    !pendingSessionAsk(current) ||
    current.interactivePrompt !== baseline.interactivePrompt ||
    current.stateStartedAt !== baseline.stateStartedAt ||
    current.terminalHandle !== baseline.terminalHandle ||
    current.connectionId !== baseline.connectionId ||
    !parsePaneKey(context.paneKey) ||
    context.readPtyId() !== context.ptyId
  ) {
    return 'gone'
  }
  // Why: unseen, a current report is believed and an old one is not (its answer goes as a message).
  const unseen: QuestionPendingState = context.confirmOnScreen ? 'gone' : 'pending'
  const screenAgent = optionOnlyAskScreenAgent(current.agentType)
  if (screenAgent) {
    // Why: no hook reports these dialogs cancelled, so only the screen can say it is still open.
    return isOptionOnlyAskOnScreen(screenAgent, context.readScreen, prompt)
      ? 'pending'
      : context.confirmOnScreen
        ? 'gone'
        : 'not-on-screen'
  }
  if (current.agentType === 'claude' && context.readScreen) {
    try {
      return isClaudeAskSelectorOpen(context.readScreen(), prompt) ? 'pending' : 'gone'
    } catch {
      // Why: an unreadable screen proves nothing; the report decides.
      return unseen
    }
  }
  return unseen
}

/** The pane's send, answering only a still-pending question; `onStale` hears it was answered. */
export function guardQuestionSend(
  send: NativeChatInteractiveSend,
  context: QuestionAnswerContext,
  onStale: () => void
): NativeChatInteractiveSend {
  return {
    ...send,
    sendAnswer: (prompt, selections, onDeliverySettled) => {
      const state = questionPendingState(context, prompt)
      if (state !== 'pending') {
        // Why two notices: "already answered" only when it was; a hidden dialog says so instead.
        if (state === 'gone') {
          onStale()
          onDeliverySettled?.(false)
        } else {
          onDeliverySettled?.(false, 'not-on-screen')
        }
        return { settleAfterMs: 0, waitsForVerifiedDelivery: false }
      }
      return send.sendAnswer(prompt, selections, onDeliverySettled)
    },
    // Why no approvals or raw keys from here: Needs you answers questions only.
    sendApproval: () => false,
    sendRaw: () => {},
    cancel: send.cancelPending
  }
}
