// An answer given on OmniOS, typed into the pane through the same guarded send the Needs you
// question card uses (all questions, multi-select, free text), or skipped with the card's Esc.
// Reports delivered only once the pane confirms: the send's verified settle, or the question leaving.

import { useAppStore } from '@/store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { pendingSessionAsk } from '../../../../shared/session-questions'
import { hasAskAnswer } from '../../../../shared/native-chat-ask'
import { omniosAnswerSelections } from '../../../../shared/omnios-answer-selections'
import type {
  SessionManageOmniosAnswerReply,
  SessionManageRendererRequest
} from '../../../../shared/session-manage-relay'
import type {
  AskAnswerRefusal,
  NativeChatSendHandle
} from '../../components/native-chat/native-chat-runtime-send'
import type { NativeChatInteractiveSend } from '../../components/native-chat/use-native-chat-interactive-send'
import { sendNativeChatInteractiveAnswer } from '../../components/native-chat/native-chat-interactive-answer'
import { readTerminalScreenReader } from '../../components/terminal-pane/terminal-screen-readers'
import {
  guardQuestionSend,
  questionPendingState,
  type QuestionAnswerContext
} from '../../components/needs-you/question-answer-guard'

type Request = Extract<SessionManageRendererRequest, { kind: 'answerOmniosQuestion' }>

const ESC = '\x1b'
/** Under main's 20s relay timeout, so a slow answer is cancelled here rather than left typing. */
export const OMNIOS_ANSWER_DEADLINE_MS = 15_000
const CONFIRM_POLL_MS = 200
const CONFIRM_AFTER_SKIP_MS = 6_000
const CONFIRM_AFTER_MESSAGE_GRACE_MS = 6_000

const GONE = 'The session is no longer waiting on this question; nothing was typed.'

function refused(error: string): SessionManageOmniosAnswerReply {
  return { delivered: false, error }
}

function refusalText(refusal: AskAnswerRefusal | undefined): string {
  return refusal === 'partial'
    ? 'The answer was partly typed; finish it in the terminal before answering again.'
    : refusal === 'not-on-screen'
      ? 'The question is not visible in its terminal; answer it at the desktop.'
      : 'The terminal did not take the answer; nothing was sent. Answer it at the desktop.'
}

/** Resolves true once the question the context pinned is no longer pending, false at the deadline. */
export function waitForQuestionToLeave(
  stillPending: () => boolean,
  withinMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (!stillPending()) {
        resolve(true)
      } else if (Date.now() - started >= withinMs) {
        resolve(false)
      } else {
        setTimeout(tick, CONFIRM_POLL_MS)
      }
    }
    tick()
  })
}

export async function answerOmniosQuestion(
  request: Request
): Promise<SessionManageOmniosAnswerReply> {
  const { paneKey } = request
  const owner = parsePaneKey(paneKey)
  const state = useAppStore.getState()
  const baseline = state.agentStatusByPaneKey[paneKey]
  const ptyId = owner
    ? state.terminalLayoutsByTabId[owner.tabId]?.ptyIdsByLeafId?.[owner.leafId]
    : null
  if (!owner || !baseline || !ptyId || baseline.interactivePrompt !== request.interactivePrompt) {
    return refused(GONE)
  }
  const prompt = pendingSessionAsk(baseline)
  if (!prompt) {
    return refused(GONE)
  }
  const readScreen = readTerminalScreenReader(paneKey)
  const context: QuestionAnswerContext = {
    paneKey,
    ptyId,
    baseline,
    readStatus: () => useAppStore.getState().agentStatusByPaneKey[paneKey],
    readPtyId: () =>
      useAppStore.getState().terminalLayoutsByTabId[owner.tabId]?.ptyIdsByLeafId?.[owner.leafId],
    ...(readScreen ? { readScreen } : {}),
    ...(request.confirmOnScreen ? { confirmOnScreen: true } : {})
  }
  const stillAsking = (): boolean => {
    const current = context.readStatus()
    return (
      Boolean(current && pendingSessionAsk(current)) &&
      current?.interactivePrompt === baseline.interactivePrompt &&
      current?.stateStartedAt === baseline.stateStartedAt
    )
  }
  const settings = getSettingsForAgentTabRuntimeOwner(owner.tabId)

  if (request.skipped) {
    const pending = questionPendingState(context, prompt)
    if (pending !== 'pending') {
      return refused(pending === 'gone' ? GONE : refusalText('not-on-screen'))
    }
    // Why Esc: the question card's Skip on a wholly unanswered prompt cancels it the same way.
    sendRuntimePtyInput(settings, ptyId, ESC)
    return (await waitForQuestionToLeave(stillAsking, CONFIRM_AFTER_SKIP_MS))
      ? { delivered: true }
      : refused('Esc was sent but the question is still open; skip it at the desktop.')
  }

  const selections = omniosAnswerSelections(prompt, request.answers)
  if (!hasAskAnswer(prompt, selections)) {
    return refused('No answer matched this question; nothing was typed.')
  }
  const inFlight: { current: NativeChatSendHandle | null } = { current: null }
  const cancelInFlight = (): void => {
    inFlight.current?.cancel()
    inFlight.current = null
  }
  const send: NativeChatInteractiveSend = {
    sendAnswer: (answerPrompt, answerSelections, onDeliverySettled) =>
      sendNativeChatInteractiveAnswer(
        {
          terminalTabId: owner.tabId,
          paneKey,
          targetPtyId: ptyId,
          agent: baseline.agentType ?? 'claude',
          readScreen: () => readScreen,
          inFlight,
          cancelInFlight
        },
        answerPrompt,
        answerSelections,
        onDeliverySettled
      ),
    sendApproval: () => false,
    sendRaw: () => {},
    cancelPending: cancelInFlight,
    cancel: cancelInFlight
  }
  const guarded = guardQuestionSend(send, context, () => {})
  return new Promise((resolve) => {
    let done = false
    const finish = (reply: SessionManageOmniosAnswerReply): void => {
      if (!done) {
        done = true
        clearTimeout(deadline)
        resolve(reply)
      }
    }
    const deadline = setTimeout(() => {
      cancelInFlight()
      finish(
        refused('The answer did not finish in time; check the session before answering again.')
      )
    }, OMNIOS_ANSWER_DEADLINE_MS)
    const result = guarded.sendAnswer(prompt, selections, (delivered, refusal) =>
      finish(delivered ? { delivered: true } : refused(refusal ? refusalText(refusal) : GONE))
    )
    if (done) {
      return
    }
    if (result.settleAfterMs === 0 && !result.waitsForVerifiedDelivery) {
      finish(refused(refusalText('not-delivered')))
    } else if (!result.waitsForVerifiedDelivery) {
      // Why watch the status: a pasted-message answer reports no settle; the question leaving does.
      void waitForQuestionToLeave(
        stillAsking,
        result.settleAfterMs + CONFIRM_AFTER_MESSAGE_GRACE_MS
      ).then((left) =>
        finish(
          left
            ? { delivered: true }
            : refused('The answer was typed but the question is still open; check the session.')
        )
      )
    }
  })
}
