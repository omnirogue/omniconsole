import { StructuredSessionWorkRail, type StructuredWorkRailRead } from './StructuredSessionWorkRail'
import { useState } from 'react'
import { useNativeChatStop } from './use-native-chat-stop'
import { useOmpSessionExit } from './use-omp-session-exit'
import { NativeChatStopNotice } from './NativeChatStopNotice'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { useAppStore } from '@/store'
import { submitPromptToAgentPty } from '@/lib/agent-paste-draft'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ConversationWorkHeader } from './ConversationWorkHeader'
import {
  resolveNativeChatSession,
  type NativeChatPaneResolution
} from './native-chat-pane-resolution'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { useNativeChatAgentExit } from './use-native-chat-agent-exit'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { NativeChatAgentExitActions } from './NativeChatAgentExitedNotice'
import { selectNativeChatRuntimeEnvironmentId } from './native-chat-runtime-owner'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

/**
 * Lives above the PTY/Chat switch, so the work source continues following its owning pane.
 *
 * It carries no prompt field of its own (Sal, 2026-09-18: "we still have two prompt boxes"):
 * the pane already has one input — the chat composer on Chat, the terminal on Terminal — and
 * a prompt for later goes through + Prompt in Up next. The rail keeps Stop, Resume and End.
 */
export function PtySessionWorkRail({
  worktreeId,
  tabId,
  structuredRead,
  isChatViewMode = false,
  paneKey,
  ptyId,
  agent,
  visible,
  readTerminalScreen,
  onSwitchToTerminal
}: {
  worktreeId: string
  tabId: string
  structuredRead?: StructuredWorkRailRead
  isChatViewMode?: boolean
  paneKey: string
  ptyId: string | null
  agent: string | null
  visible: boolean
  readTerminalScreen: () => string | null
  /** Opens Terminal for the exit notice's "Open Terminal" action, shared with the chat view. */
  onSwitchToTerminal?: () => void
}) {
  const entry = useAppStore((state) => state.agentStatusByPaneKey[paneKey])
  const runtimeEnvironmentId = useAppStore((state) =>
    selectNativeChatRuntimeEnvironmentId(state, tabId)
  )
  const exit = useNativeChatAgentExit({
    terminalTabId: tabId,
    paneKey,
    targetPtyId: ptyId,
    hasLiveEntry: !!entry
  })
  const resolution = resolveNativeChatSession({
    paneKey,
    ptyId,
    agentStatusEntry: entry,
    resolvedAgent: agent && isTuiAgent(agent) ? agent : null,
    sleepingRecord: exit.record
  })
  if (structuredRead) {
    return (
      <StructuredSessionWorkRail
        worktreeId={worktreeId}
        tabId={tabId}
        paneKey={paneKey}
        read={structuredRead}
      />
    )
  }
  if (!resolution) {
    return agent || entry || isChatViewMode ? (
      <ConversationWorkHeader worktreeId={worktreeId} paneKey={paneKey} tabId={tabId} />
    ) : null
  }
  return (
    <ResolvedWorkRail
      key={JSON.stringify([
        runtimeEnvironmentId,
        paneKey,
        resolution.agent,
        resolution.ptyId,
        resolution.sessionId
      ])}
      worktreeId={worktreeId}
      tabId={tabId}
      resolution={resolution}
      runtimeEnvironmentId={runtimeEnvironmentId}
      visible={visible}
      readTerminalScreen={readTerminalScreen}
      agentExit={exit.agentExit}
      onSwitchToTerminal={onSwitchToTerminal}
    />
  )
}

function ResolvedWorkRail({
  worktreeId,
  tabId,
  resolution,
  runtimeEnvironmentId,
  visible,
  agentExit,
  readTerminalScreen,
  onSwitchToTerminal
}: {
  worktreeId: string
  tabId: string
  resolution: NativeChatPaneResolution
  runtimeEnvironmentId: string | null
  visible: boolean
  agentExit: ReturnType<typeof useNativeChatAgentExit>['agentExit']
  readTerminalScreen: () => string | null
  onSwitchToTerminal?: () => void
}) {
  const { paneKey, agent, sessionId, transcriptPath, ptyId } = resolution
  const session = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId,
    terminalTabId: tabId,
    enabled: visible
  })
  const canSend = useNativeChatCanSend(ptyId)
  const connectionId = useAppStore((state) => state.agentStatusByPaneKey[paneKey]?.connectionId)
  const interactive = useNativeChatInteractiveSend(tabId, paneKey, ptyId, agent, readTerminalScreen)
  const observedInterrupted = useAppStore(
    (state) => state.agentStatusByPaneKey[paneKey]?.interrupted
  )
  const turnStartedAt = useAppStore((state) => state.agentStatusByPaneKey[paneKey]?.stateStartedAt)
  const workingEpoch = useAppStore((state) => {
    const entry = state.agentStatusByPaneKey[paneKey]
    return entry?.state === 'working'
      ? (entry.stateStartedAt ?? null)
      : (entry?.stateHistory?.findLast((event) => event.state === 'working')?.startedAt ?? null)
  })
  const [interruption, setInterruption] = useState<{
    interrupted: boolean
    workingEpoch: number | null
    observedEpoch: number | undefined
  } | null>(null)
  const sameTurn = interruption?.workingEpoch === workingEpoch
  // History also fences a new turn that starts and finishes between renderer updates.
  const interrupted =
    (sameTurn && interruption?.interrupted === true) ||
    (observedInterrupted === true &&
      !(
        sameTurn &&
        interruption?.interrupted === false &&
        interruption.observedEpoch === turnStartedAt
      ))
  const recordInterruption = (value: boolean) =>
    setInterruption({ interrupted: value, workingEpoch, observedEpoch: turnStartedAt })
  const stopping = useNativeChatStop({
    agent,
    terminalTabId: tabId,
    paneKey,
    ptyId,
    sessionId,
    runtimeEnvironmentId,
    connectionId,
    agentExited: !!agentExit,
    readTerminalScreen,
    readSnapshot: () =>
      session.readPhase === 'ready' && session.sessionId === sessionId && session.agent === agent
        ? session
        : null,
    interactiveSend: interactive,
    onInterrupted: () => recordInterruption(true)
  })
  const ending = useOmpSessionExit({
    agent,
    tabId,
    paneKey,
    ptyId,
    sessionId,
    runtimeEnvironmentId,
    connectionId,
    agentExited: !!agentExit
  })
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const resume = async () => {
    if (!ptyId || sending || stopping.pending || stopping.unverified || ending.requested) {
      return
    }
    setSending(true)
    setError('')
    try {
      if (
        !(await submitPromptToAgentPty({
          tabId,
          ptyId,
          content:
            'Continue the interrupted work from where you stopped, preserving the existing scope and instructions.'
        }))
      ) {
        throw new Error(
          translate('chatActions.sendFailed', 'The action could not be sent. Try again.')
        )
      }
      stopping.reset()
      recordInterruption(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="shrink-0 bg-background" data-session-work-rail={paneKey}>
      <ConversationWorkHeader
        worktreeId={worktreeId}
        paneKey={paneKey}
        tabId={tabId}
        messages={session.messages}
      />
      {agentExit ? (
        <NativeChatAgentExitActions
          agent={agent}
          agentExit={agentExit}
          terminalTabId={tabId}
          onSwitchToTerminal={onSwitchToTerminal}
        />
      ) : ptyId && session.status === 'working' && !interrupted ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={
            !canSend ||
            stopping.pending ||
            ending.phase === 'pending' ||
            ending.phase === 'requested'
          }
          onClick={stopping.stop}
        >
          {translate('components.native-chat.stop', 'Stop the agent')}
        </Button>
      ) : null}
      {interrupted && !agentExit ? (
        <Button
          size="xs"
          variant="outline"
          disabled={
            !canSend || sending || stopping.pending || stopping.unverified || ending.requested
          }
          onClick={() => void resume()}
        >
          {translate('conversations.agentExited.action.resume', 'Resume conversation')}
        </Button>
      ) : null}
      {agent === 'omp' && ptyId && sessionId && !agentExit ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!canSend || stopping.pending || ending.requested}
          onClick={() => void ending.end()}
        >
          {translate('components.native-chat.endSession', 'End OMP session')}
        </Button>
      ) : null}
      {ending.requested && !agentExit ? (
        <p
          role={ending.phase === 'unverified' ? 'alert' : 'status'}
          className="text-xs text-muted-foreground"
        >
          {ending.error ??
            (ending.phase === 'pending'
              ? translate('components.native-chat.endSessionSending', 'Requesting session exit…')
              : translate(
                  'components.native-chat.endSessionPending',
                  'Exit requested. Resume becomes available after OMP exits. Check Terminal if it stays open.'
                ))}
        </p>
      ) : null}
      <NativeChatStopNotice
        pending={stopping.pending}
        unverified={stopping.unverified}
        backgroundStopRequested={stopping.backgroundStopRequested}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
