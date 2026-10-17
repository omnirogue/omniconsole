import React, { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { pendingSessionAsk, sessionQuestionSummary } from '../../../../shared/session-questions'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { NativeChatInteractiveCard } from '../native-chat/NativeChatInteractiveCard'
import { useNativeChatCanSend } from '../native-chat/use-native-chat-can-send'
import { useNativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'
import { useTerminalScreenReader } from '../terminal-pane/terminal-screen-readers'
import { guardQuestionSend } from './question-answer-guard'
import { PairedQuestionAnswer } from './PairedQuestionAnswer'

type RowProps = {
  paneKey: string
  /** Omitted where the session's own row sits right above (the project page). */
  title?: string
  /** Opens the session itself (the terminal stays the fallback, never raw typing from here). */
  onOpen?: () => void
  answerable?: boolean
}

function staleAnswer(): void {
  toast.message(
    translate(
      'needsYou.questionGone',
      'That question was already answered, or the session moved on. Nothing was sent.'
    )
  )
}

function Frame({
  paneKey,
  title,
  onOpen,
  children
}: RowProps & { children: React.ReactNode }): React.JSX.Element {
  const headed = title !== undefined || onOpen !== undefined
  return (
    <li
      className={
        headed ? 'space-y-1.5 rounded-lg border bg-card px-3 py-2' : 'space-y-1.5 px-1 py-1'
      }
      data-needs-you-question={paneKey}
    >
      {headed ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          {onOpen ? (
            <Button size="xs" variant="ghost" onClick={onOpen}>
              {translate('needsYou.openSession', 'Open')}
              <ChevronRight className="size-3" aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      {children}
    </li>
  )
}

function LiveQuestion({
  paneKey,
  tabId,
  ptyId,
  baseline
}: {
  paneKey: string
  tabId: string
  ptyId: string
  baseline: AgentStatusEntry
}): React.JSX.Element {
  const readScreen = useTerminalScreenReader(paneKey)
  const agent = baseline.agentType ?? 'claude'
  const send = useNativeChatInteractiveSend(tabId, paneKey, ptyId, agent, readScreen)
  const canSend = useNativeChatCanSend(ptyId)
  const leafId = parsePaneKey(paneKey)?.leafId
  const guarded = useMemo(
    () =>
      guardQuestionSend(
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
      ),
    [send, paneKey, ptyId, baseline, tabId, leafId, readScreen]
  )
  return (
    <NativeChatInteractiveCard
      paneKey={paneKey}
      send={guarded}
      canSend={canSend}
      transcriptSettled={false}
    />
  )
}

/**
 * One session's pending question in Needs you: its options as one-click answers (multi-select:
 * tick and Send; "Other…" a line of text), sent as the pane's own card sends them. A question that
 * cannot be answered from here (no live terminal) says so and offers Open.
 */
export function NeedsYouQuestionRow({
  paneKey,
  title,
  onOpen,
  answerable = true
}: RowProps): React.JSX.Element | null {
  const status = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  const owner = parsePaneKey(paneKey)
  const ptyId = useAppStore((state) =>
    owner
      ? (state.terminalLayoutsByTabId[owner.tabId]?.ptyIdsByLeafId?.[owner.leafId] ?? null)
      : null
  )
  const ask = status ? pendingSessionAsk(status) : null
  if (!status || !ask) {
    return null
  }
  if (!answerable || !owner || !ptyId) {
    return (
      <Frame paneKey={paneKey} title={title} onOpen={onOpen}>
        <div className="text-sm">{sessionQuestionSummary(ask)}</div>
        <div className="text-xs text-muted-foreground" data-needs-you-unreachable="">
          {translate(
            'needsYou.cannotAnswerHere',
            'Can’t answer from here: this session’s terminal isn’t reachable. Open it to answer.'
          )}
        </div>
      </Frame>
    )
  }
  if (parseRemoteRuntimePtyId(ptyId) !== null) {
    return (
      <Frame paneKey={paneKey} title={title} onOpen={onOpen}>
        <PairedQuestionAnswer paneKey={paneKey} summary={sessionQuestionSummary(ask)} />
      </Frame>
    )
  }
  return (
    <Frame paneKey={paneKey} title={title} onOpen={onOpen}>
      <LiveQuestion paneKey={paneKey} tabId={owner.tabId} ptyId={ptyId} baseline={status} />
    </Frame>
  )
}
