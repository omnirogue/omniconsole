import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import {
  latestNativeChatAskOccurrence,
  resolveNativeChatAsk
} from '../../../../shared/native-chat-ask'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { resolveAskAnswerSurface } from '../../../../shared/native-chat-ask-answer-keys'
import { parseInteractivePrompt } from './native-chat-interactive-prompt'
import { nativeChatCardDismissKey } from './native-chat-dismiss-key'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { showAskAnswerRefusalNotice } from './ask-answer-refusal-notice'
import {
  dismissAsyncQuestions,
  showAsyncQuestionDismissalRefusalNotice
} from './async-question-dismissal'
import { NativeChatApprovalInteraction } from './NativeChatApprovalInteraction'
import { NativeChatTerminalDecisionNotice } from './NativeChatTerminalDecisionNotice'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/**
 * Render the live interactive card for the pane while the agent's
 * `interactivePrompt` is present: a question wizard (precedence) or a tool
 * approval. Cleared by the host once the agent moves on, so it disappears
 * automatically. Sends through the composer's verified runtime path (R8/R6):
 * answers via agent-specific paste or selector keystrokes; cancel/deny as ESC.
 * Guarded by `canSend` so a mobile presence-lock blocks desktop sends too.
 *
 * Dismiss-on-answer (mobile parity): the live status lingers after answering —
 * the agent emits a post-tool event carrying the same prompt — so we track the
 * answered prompt by content key and hide the card until a genuinely different
 * prompt arrives. A missing status is not a new question: only a new transcript
 * occurrence can reopen an identical question after successful delivery.
 *
 * The transcript is the second source (mobile parity again): a question that the
 * live status never delivered — headless host, relay gap, replay, reconnect —
 * still has its unresolved tool call in the messages we already parsed. Without
 * it the composer stays mounted over a pane parked on a selector, and the next
 * send commits the highlighted option instead of the typed message (#11761).
 */
export function NativeChatInteractiveCard({
  paneKey,
  send,
  canSend,
  messages,
  transcriptSettled,
  onShowingQuestionChange,
  answerInputRef,
  onSwitchToTerminal
}: {
  paneKey: string
  send: NativeChatInteractiveSend
  canSend: boolean
  /** Transcript to fall back on when live status carries no prompt. Pass the
   *  command-boundary-trimmed messages so an ask abandoned via `/clear` stays gone. */
  messages?: readonly NativeChatMessage[]
  transcriptSettled: boolean
  /** Hides the composer while a question or approval owns the agent's input. */
  onShowingQuestionChange?: (showing: boolean) => void
  /** Forwarded to the question card's free-text row so pane-level Paste keeps
   *  a target while the composer is unmounted. */
  answerInputRef?: React.RefObject<HTMLInputElement | null>
  onSwitchToTerminal?: () => void
}): React.JSX.Element | null {
  const interactivePrompt = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.interactivePrompt ?? null
  )
  // Thread the sibling `toolName` from the same status entry so the question
  // parser can dispatch through the tool's registered parser (mobile parity).
  const interactiveToolName = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.toolName ?? null)
  const agentType = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.agentType ?? null)
  const ompBlocked = useAppStore((s) => {
    const status = s.agentStatusByPaneKey[paneKey]
    return status?.agentType === 'omp' && status.state === 'blocked'
  })
  const { sendAnswer, sendApproval, cancelPending, cancel } = send

  const card = useMemo(() => {
    const statusCard = parseInteractivePrompt(interactivePrompt, interactiveToolName ?? undefined)
    if (statusCard?.kind === 'approval') {
      return statusCard
    }
    const prompt = resolveNativeChatAsk({
      liveAsk: statusCard?.prompt ?? null,
      messages: messages ?? [],
      transcriptSettled: transcriptSettled && messages != null
    })
    return prompt ? { kind: 'question' as const, prompt } : null
  }, [interactivePrompt, interactiveToolName, messages, transcriptSettled])
  const cardKey = useMemo(() => nativeChatCardDismissKey(card), [card])
  const occurrence =
    card?.kind === 'question' ? latestNativeChatAskOccurrence(messages ?? [], card.prompt) : null
  const [dismissal, setDismissal] = useState<{
    key: string | null
    occurrence: string | null
  } | null>(null)
  const setDismissedKey = (key: string | null): void => setDismissal({ key, occurrence })
  const dismissed =
    dismissal?.key === cardKey &&
    (!dismissal?.occurrence || !occurrence || dismissal.occurrence === occurrence)
  // Live status can beat the transcript; attach its first occurrence without reopening it.
  useEffect(() => {
    if (dismissed && occurrence && !dismissal?.occurrence) {
      setDismissal({ key: cardKey, occurrence })
    }
  }, [cardKey, dismissal, dismissed, occurrence])
  // A question answer is a paced multi-step write (body→Enter per question); keep
  // the card up until it settles instead of dismissing on the click, so it doesn't
  // vanish mid-send. `submitting` also gates a second submit racing the first.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissRequestRef = useRef<object | null>(null)
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const clearDismissTimer = useCallback((): void => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    submittingRef.current = false
    setSubmitting(false)
  }, [])
  // A replacement prompt, ownership loss, or unmount must stop both timers and
  // PTY writes during commit, before an old answer can type into the new prompt.
  useLayoutEffect(
    () => () => {
      clearDismissTimer()
      cancelPending()
    },
    [canSend, cardKey, cancelPending, clearDismissTimer]
  )
  useLayoutEffect(
    () => () => {
      if (dismissRequestRef.current) {
        dismissRequestRef.current = null
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [paneKey, canSend, cardKey, occurrence]
  )

  // A status gap clears legacy approvals, but cannot forget an answered question.
  if (!card && dismissal && !dismissal.key?.startsWith('question:')) {
    setDismissal(null)
  }

  // A composer send must not become a keystroke in a pending approval selector.
  // Preserved pre-upgrade OMP processes cannot identify an approval safely in Chat.
  const terminalDecision = !card && ompBlocked && canSend
  const showingQuestion = terminalDecision || (card != null && canSend && !dismissed)
  useEffect(() => {
    onShowingQuestionChange?.(showingQuestion)
    return () => onShowingQuestionChange?.(false)
  }, [showingQuestion, onShowingQuestionChange])

  if (terminalDecision) {
    return <NativeChatTerminalDecisionNotice onSwitchToTerminal={onSwitchToTerminal} />
  }
  if (!card || !canSend || dismissed) {
    return null
  }
  if (card.kind === 'question') {
    const prompt = card.prompt
    const surface = resolveAskAnswerSurface(agentType, prompt)
    const dismissOnOwner = (): void => {
      const request = {}
      dismissRequestRef.current = request
      submittingRef.current = true
      setSubmitting(true)
      void dismissAsyncQuestions(paneKey, prompt.questions).then((result) => {
        if (dismissRequestRef.current !== request) {
          return
        }
        dismissRequestRef.current = null
        submittingRef.current = false
        setSubmitting(false)
        if (result === 'dismissed') {
          setDismissedKey(cardKey)
        } else {
          showAsyncQuestionDismissalRefusalNotice(result)
        }
      })
    }
    return (
      <NativeChatQuestionCard
        key={nativeChatCardDismissKey({ kind: 'question', prompt }) ?? 'question'}
        prompt={prompt}
        allowOther={surface.allowOther}
        requireEveryAnswer={surface.requireEveryAnswer}
        answerInTerminal={surface.answerInTerminal}
        isSubmitting={submitting}
        answerInputRef={answerInputRef}
        onAnswer={(selections) => {
          if (submittingRef.current) {
            return
          }
          submittingRef.current = true
          const dismissAnsweredCard = (): void => {
            setDismissedKey(cardKey)
            submittingRef.current = false
            setSubmitting(false)
            dismissTimerRef.current = null
          }
          const keepRejectedAnswerVisible = (): void => {
            submittingRef.current = false
            setSubmitting(false)
          }
          const result = sendAnswer(prompt, selections, (delivered, refusal) => {
            if (delivered) {
              dismissAnsweredCard()
              return
            }
            keepRejectedAnswerVisible()
            if (refusal) {
              showAskAnswerRefusalNotice(refusal)
            }
          })
          if (result.settleAfterMs <= 0) {
            // Keep the actionable card visible when its PTY disappeared between
            // render and submit; the next live target update can make it retryable.
            keepRejectedAnswerVisible()
            return
          }
          setSubmitting(true)
          if (result.waitsForVerifiedDelivery) {
            // Why: remote acceptance can outlive the keystroke pacing window.
            // Keep the card until delivery is proven instead of cancelling the
            // inference callback at the old fixed dismissal deadline.
            return
          }
          // Hold the card until the paced write finishes, then mark it answered
          // (which hides it and restores the composer).
          dismissTimerRef.current = setTimeout(() => {
            cancelPending()
            dismissAnsweredCard()
          }, result.settleAfterMs)
        }}
        onCancel={() => {
          if (dismissRequestRef.current) {
            return
          }
          clearDismissTimer()
          // Why no Esc for an async question: Codex is idle; a second Esc edits the last message.
          if (prompt.delivery === 'async') {
            cancelPending()
            dismissOnOwner()
          } else {
            setDismissedKey(cardKey)
            cancel()
          }
        }}
      />
    )
  }
  return (
    <NativeChatApprovalInteraction
      key={cardKey}
      approval={card.approval}
      interactivePrompt={interactivePrompt}
      sendApproval={sendApproval}
      onDelivered={() => setDismissedKey(cardKey)}
    />
  )
}
