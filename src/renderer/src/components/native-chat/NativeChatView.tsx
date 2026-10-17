import { useNativeChatResumeReady } from './use-native-chat-resume-ready'
import { useAppStore } from '@/store'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NativeChatResolvedView } from './NativeChatResolvedView'
import { useNativeChatStatusEntry } from './use-native-chat-status-entry'
import { useNativeChatAgentExit } from './use-native-chat-agent-exit'
import type { NativeChatViewProps } from './native-chat-view-types'

export type { NativeChatViewProps } from './native-chat-view-types'

/** Resolves an agent terminal into its native conversation and composer UI. */
export default function NativeChatView(props: NativeChatViewProps): React.JSX.Element {
  if (props.mode === 'structured') {
    return <NativeChatStructuredSession key={props.sessionId} {...props} />
  }
  return <NativeChatBridgeView {...props} />
}

function NativeChatBridgeView({
  worktreeId,
  terminalTabId,
  isVisible,
  transcriptLive,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  resolvedAgent,
  ownsTabWideLaunchDraft,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions,
  orchestrationDispatchStatus,
  workRailInShell,
  exitNoticeInShell
}: Exclude<NativeChatViewProps, { mode: 'structured' }>): React.JSX.Element {
  const { entry: agentStatusEntry, paneKey } = useNativeChatStatusEntry(
    terminalTabId,
    preferredPaneKey
  )
  const resumeClaim = useAppStore((state) =>
    ownsTabWideLaunchDraft ? state.automaticAgentResumeClaimsByTabId[terminalTabId] : undefined
  )
  const resumeReady = useNativeChatResumeReady({
    resuming: Boolean(resumeClaim),
    active: isVisible,
    paneKey,
    ptyId: targetPtyId,
    agent: launchAgent ?? resolvedAgent ?? '',
    readScreen: readTerminalScreen
  })
  const exit = useNativeChatAgentExit({
    terminalTabId,
    paneKey,
    targetPtyId,
    hasLiveEntry: agentStatusEntry !== undefined
  })
  return (
    <NativeChatSessionGate
      paneKey={paneKey}
      launchAgent={launchAgent}
      resolvedAgent={resolvedAgent}
      agentStatusEntry={agentStatusEntry}
      sleepingRecord={exit.record}
      resumeSession={
        resumeClaim
          ? { agent: resumeClaim.launchAgent, providerSession: resumeClaim.providerSession }
          : undefined
      }
      ptyId={targetPtyId}
    >
      {(resolution) => (
        <NativeChatResolvedView
          worktreeId={worktreeId}
          paneKey={resolution.paneKey}
          agentExit={exit.agentExit}
          resumePending={!resumeReady}
          agent={resolution.agent}
          sessionId={resolution.sessionId}
          transcriptPath={resolution.transcriptPath}
          isVisible={isVisible}
          transcriptLive={transcriptLive}
          targetPtyId={targetPtyId}
          terminalTabId={terminalTabId}
          ownsTabWideLaunchDraft={ownsTabWideLaunchDraft}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          contextMenuActions={contextMenuActions}
          workRailInShell={workRailInShell}
          exitNoticeInShell={exitNoticeInShell}
          orchestrationDispatchStatus={orchestrationDispatchStatus}
        />
      )}
    </NativeChatSessionGate>
  )
}
