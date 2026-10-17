import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AgentType } from '../../../../shared/native-chat-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { sendNativeChatApproval } from './native-chat-approval-send'
import {
  buildNativeChatApprovalKeys,
  parseApprovalFromStatus,
  type AskAnswerSelection,
  type AskPrompt
} from './native-chat-interactive-prompt'
import type { AskAnswerRefusal, NativeChatSendHandle } from './native-chat-runtime-send'
import { sendNativeChatInteractiveAnswer } from './native-chat-interactive-answer'

// ESC is the agent-TUI interrupt/cancel key over the PTY (matches how the
// composer forwards Escape). Used to cancel a question or deny an approval.
const ESC = '\x1b'

export type NativeChatInteractiveSend = {
  /** Deliver the answer to an AskUserQuestion prompt. Claude-format selectors
   *  verify every runtime write before reporting settlement. */
  sendAnswer: (
    prompt: AskPrompt,
    selections: AskAnswerSelection[],
    /** Why nothing (or not everything) was sent, when the person must finish in the terminal. */
    onDeliverySettled?: (delivered: boolean, refusal?: AskAnswerRefusal) => void
  ) => { settleAfterMs: number; waitsForVerifiedDelivery: boolean }
  /** Approve only the still-current request and await each host-accepted control key. */
  sendApproval: (
    interactivePrompt: string,
    choice: string,
    onDeliverySettled: (delivered: boolean) => void
  ) => boolean
  /** Send a raw control string (e.g. an approval option number or ESC) as-is. */
  sendRaw: (raw: string) => void
  /** Stop delayed writes without interrupting the agent. */
  cancelPending: () => void
  /** Send ESC to interrupt — cancels a question / denies an approval. */
  cancel: () => void
}

/**
 * Reuse the desktop composer's exact send path for the interactive cards:
 * resolve this tab's live ptyId + runtime owner settings, then write bytes via
 * `sendRuntimePtyInput` (which branches local pty:write vs remote runtime RPC,
 * so SSH panes work unchanged). Native selectors use their respective
 * selector keystrokes via `sendNativeChatAskAnswer`; other agents still go through
 * `sendNativeChatMessage`. Control strings (option digits, ESC) are written raw.
 */
export function useNativeChatInteractiveSend(
  terminalTabId: string,
  paneKey: string,
  targetPtyId: string | null,
  agent: AgentType,
  /** The pane's visible terminal text; confirms a Claude answer actually closed its selector. */
  readTerminalScreen?: () => string | null
): NativeChatInteractiveSend {
  // The in-flight answer's cancel handle; cleared on a new send, on Stop, and on
  // unmount so a detached setTimeout chain can't keep writing PTY bytes after
  // the view is gone / the user switched away.
  const inFlightRef = useRef<NativeChatSendHandle | null>(null)
  const readScreenRef = useRef(readTerminalScreen)
  useLayoutEffect(() => {
    readScreenRef.current = readTerminalScreen
  }, [readTerminalScreen])
  const cancelInFlight = useCallback(() => {
    inFlightRef.current?.cancel()
    inFlightRef.current = null
  }, [])
  // Why: a split can be rebound without unmounting this view. Cancel during
  // commit so no delayed answer write can race the replacement PTY.
  useLayoutEffect(
    () => cancelInFlight,
    [agent, cancelInFlight, paneKey, targetPtyId, terminalTabId]
  )

  const sendRaw = useCallback(
    (raw: string) => {
      if (!targetPtyId) {
        return
      }
      sendRuntimePtyInput(getSettingsForAgentTabRuntimeOwner(terminalTabId), targetPtyId, raw)
    },
    [terminalTabId, targetPtyId]
  )

  const sendApproval = useCallback(
    (
      interactivePrompt: string,
      choice: string,
      onDeliverySettled: (delivered: boolean) => void
    ): boolean => {
      const owner = parsePaneKey(paneKey)
      const approval = parseApprovalFromStatus(interactivePrompt)
      const baseline = useAppStore.getState().agentStatusByPaneKey[paneKey]
      if (
        !targetPtyId ||
        !owner ||
        owner.tabId !== terminalTabId ||
        !approval ||
        !baseline ||
        inFlightRef.current
      ) {
        return false
      }
      const keys = buildNativeChatApprovalKeys(approval, choice, agent)
      const isCurrent = (): boolean => {
        const state = useAppStore.getState()
        const current = state.agentStatusByPaneKey[paneKey]
        return (
          current?.state === 'blocked' &&
          !current.restoredUnconfirmed &&
          current.agentType === agent &&
          current.interactivePrompt === interactivePrompt &&
          current.connectionId === baseline.connectionId &&
          current.terminalHandle === baseline.terminalHandle &&
          current.providerSession?.id === baseline.providerSession?.id &&
          state.terminalLayoutsByTabId[terminalTabId]?.ptyIdsByLeafId?.[owner.leafId] ===
            targetPtyId
        )
      }
      if (keys.length === 0 || !isCurrent()) {
        return false
      }
      const handle = sendNativeChatApproval({
        settings: getSettingsForAgentTabRuntimeOwner(terminalTabId),
        ptyId: targetPtyId,
        keys,
        isCurrent,
        onSettled: (delivered) => {
          if (inFlightRef.current === handle) {
            inFlightRef.current = null
          }
          onDeliverySettled(delivered)
        }
      })
      inFlightRef.current = handle
      return true
    },
    [agent, paneKey, targetPtyId, terminalTabId]
  )

  const sendAnswer = useCallback(
    (
      prompt: AskPrompt,
      selections: AskAnswerSelection[],
      onDeliverySettled?: (delivered: boolean, refusal?: AskAnswerRefusal) => void
    ): { settleAfterMs: number; waitsForVerifiedDelivery: boolean } =>
      sendNativeChatInteractiveAnswer(
        {
          terminalTabId,
          paneKey,
          targetPtyId,
          agent,
          readScreen: () => readScreenRef.current,
          inFlight: inFlightRef,
          cancelInFlight
        },
        prompt,
        selections,
        onDeliverySettled
      ),
    [terminalTabId, paneKey, targetPtyId, agent, cancelInFlight]
  )

  // Stop/cancel: drop any pending answer writes, then send ESC to interrupt.
  const cancel = useCallback(() => {
    cancelInFlight()
    sendRaw(ESC)
  }, [cancelInFlight, sendRaw])

  return { sendAnswer, sendApproval, sendRaw, cancelPending: cancelInFlight, cancel }
}
