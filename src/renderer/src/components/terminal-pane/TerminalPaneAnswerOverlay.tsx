import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NativeChatInteractiveCard } from '../native-chat/NativeChatInteractiveCard'
import { parseInteractivePrompt } from '../native-chat/native-chat-interactive-prompt'
import { useNativeChatCanSend } from '../native-chat/use-native-chat-can-send'
import { useNativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'
import { NextStepsTerminalPill } from '../next-steps/NextStepsTerminalPill'
import { useRegisterTerminalScreenReader } from './terminal-screen-readers'

type QuestionProps = {
  tabId: string
  paneKey: string
  ptyId: string | null
  readTerminalScreen: () => string | null
  onShowingChange: (showing: boolean) => void
}

function LiveQuestion({
  tabId,
  paneKey,
  ptyId,
  agent,
  readTerminalScreen,
  onShowingChange
}: QuestionProps & { ptyId: string; agent: AgentType }) {
  const send = useNativeChatInteractiveSend(tabId, paneKey, ptyId, agent, readTerminalScreen)
  const canSend = useNativeChatCanSend(ptyId)
  const [showing, setShowing] = useState(false)
  const onShowing = useCallback(
    (next: boolean) => {
      setShowing(next)
      onShowingChange(next)
    },
    [onShowingChange]
  )
  return (
    <div
      className="pointer-events-none absolute top-11 right-3 z-20 flex max-h-[60%] w-[28rem] max-w-[calc(100%-1.5rem)] flex-col"
      data-terminal-agent-question={paneKey}
    >
      <div
        className={cn(
          'scrollbar-sleek pointer-events-auto min-h-0 overflow-y-auto rounded-md border border-border shadow-md',
          !showing && 'hidden'
        )}
      >
        <NativeChatInteractiveCard
          paneKey={paneKey}
          send={send}
          canSend={canSend}
          transcriptSettled={false}
          onShowingQuestionChange={onShowing}
        />
      </div>
    </div>
  )
}

/**
 * The agent asked a question (AskUserQuestion) in a pane shown as its terminal: the same card the
 * chat view shows, in the pane's top-right corner, so an option is a click instead of arrow keys.
 * Answers go through the chat view's send hook, as the same keystrokes. Approvals stay in the
 * terminal's own prompt.
 */
export function TerminalAgentQuestionCard(props: QuestionProps) {
  const { paneKey, ptyId } = props
  const agent = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.agentType ?? null)
  const interactivePrompt = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.interactivePrompt ?? null
  )
  const toolName = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.toolName ?? null)
  const question = useMemo(
    () => parseInteractivePrompt(interactivePrompt, toolName ?? undefined)?.kind === 'question',
    [interactivePrompt, toolName]
  )
  // Unmounting the card reports it hidden (its own effect cleanup), so nothing stays suppressed.
  return question && agent && ptyId ? <LiveQuestion {...props} ptyId={ptyId} agent={agent} /> : null
}

/**
 * The terminal pane's top-right corner: an open agent question first, else the next-steps pill,
 * checklist or Retry. Next steps are skipped while a question is open anyway.
 */
export function TerminalPaneAnswerOverlay({
  worktreeId,
  tabId,
  paneKey,
  ptyId,
  readTerminalScreen
}: {
  worktreeId: string
  tabId: string
  paneKey: string
  ptyId: string | null
  readTerminalScreen: () => string | null
}) {
  const [questionShown, setQuestionShown] = useState(false)
  useRegisterTerminalScreenReader(paneKey, readTerminalScreen)
  return (
    <>
      <TerminalAgentQuestionCard
        tabId={tabId}
        paneKey={paneKey}
        ptyId={ptyId}
        readTerminalScreen={readTerminalScreen}
        onShowingChange={setQuestionShown}
      />
      <NextStepsTerminalPill
        worktreeId={worktreeId}
        tabId={tabId}
        paneKey={paneKey}
        suppressed={questionShown}
      />
    </>
  )
}
