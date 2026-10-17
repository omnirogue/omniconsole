import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { NativeChatInteractiveCard } from '../native-chat/NativeChatInteractiveCard'
import { useNativeChatCanSend } from '../native-chat/use-native-chat-can-send'
import {
  useNativeChatInteractiveSend,
  type NativeChatInteractiveSend
} from '../native-chat/use-native-chat-interactive-send'
import { useTerminalScreenReader } from '../terminal-pane/terminal-screen-readers'
import { guardQuestionSend } from './question-answer-guard'

function staleAnswer(): void {
  toast.message(
    translate(
      'needsYou.questionGone',
      'That question was already answered, or the session moved on. Nothing was sent.'
    )
  )
}

/**
 * The live question in the Decisions box: the terminal's own card and send path (selector
 * keystrokes, guarded to a still-pending question). `onAnswered` fires once the card has finished
 * delivering and hides itself — never mid-send, because unmounting the card cancels its writes.
 */
export function DecisionLiveQuestion({
  paneKey,
  tabId,
  ptyId,
  baseline,
  onAnswered
}: {
  paneKey: string
  tabId: string
  ptyId: string
  baseline: AgentStatusEntry
  onAnswered: () => void
}): React.JSX.Element {
  const readScreen = useTerminalScreenReader(paneKey)
  const send = useNativeChatInteractiveSend(
    tabId,
    paneKey,
    ptyId,
    baseline.agentType ?? 'claude',
    readScreen
  )
  const canSend = useNativeChatCanSend(ptyId)
  const leafId = parsePaneKey(paneKey)?.leafId
  const answering = useRef(false)
  const answered = useRef(onAnswered)
  useEffect(() => {
    answered.current = onAnswered
  }, [onAnswered])
  const guarded = useMemo((): NativeChatInteractiveSend => {
    const base = guardQuestionSend(
      send,
      {
        paneKey,
        ptyId,
        baseline,
        readStatus: () => useAppStore.getState().agentStatusByPaneKey[paneKey],
        readPtyId: () =>
          leafId
            ? useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
            : null,
        ...(readScreen ? { readScreen } : {})
      },
      staleAnswer
    )
    return {
      ...base,
      sendAnswer: (prompt, selections, onDeliverySettled) => {
        // Why the refusal too: the card turns it into the notice that says why nothing was sent.
        const result = base.sendAnswer(prompt, selections, (delivered, refusal) => {
          if (!delivered) {
            answering.current = false
          }
          onDeliverySettled?.(delivered, refusal)
        })
        answering.current = result.settleAfterMs > 0
        return result
      }
    }
  }, [send, paneKey, ptyId, baseline, tabId, leafId, readScreen])
  // Why stable: the card re-reports visibility whenever this callback changes identity.
  const onShowingQuestionChange = useCallback((showing: boolean) => {
    if (!showing && answering.current) {
      answering.current = false
      answered.current()
    }
  }, [])
  return (
    <NativeChatInteractiveCard
      paneKey={paneKey}
      send={guarded}
      canSend={canSend}
      transcriptSettled={false}
      onShowingQuestionChange={onShowingQuestionChange}
    />
  )
}
