import type {
  AgentStatusOrchestrationContext,
  AgentType
} from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

type NativeChatOrchestrationProps = {
  worktreeId: string
  workRailInShell?: boolean
  /** Overrides workRailInShell for the exit banner only: a split pane can
   * share workRailInShell (header dedupe) while owning a different pane than
   * the one rendering the shared rail, so it still needs its own exit notice.
   * Defaults to workRailInShell when omitted. */
  exitNoticeInShell?: boolean
  orchestrationDispatchStatus?: AgentStatusOrchestrationContext['dispatchStatus']
}

export type NativeChatBridgeViewProps = NativeChatOrchestrationProps & {
  mode?: 'bridge'
  /** The terminal tab hosting the agent. paneKey is `${tabId}:${leafId}`. */
  terminalTabId: string
  /** Whether the hosted terminal surface is currently visible. */
  isVisible: boolean
  /** Whether the tab itself is on screen; keeps the transcript stream warm
   * across this tab's Chat<->Terminal switches, closed once the tab (or its
   * worktree) is no longer visible. Independent of Chat/Terminal mode. */
  transcriptLive: boolean
  /** Specific split leaf this chat surface replaces. */
  paneKey?: string
  /** PTY bound to `paneKey`, used for composer and interactive-card sends. */
  targetPtyId?: string | null
  /** Launch-time agent hint from the TerminalTab, when OmniConsole started one. */
  launchAgent?: TuiAgent | null
  /** Trusted title/foreground fallback for manually-started agents. */
  resolvedAgent?: TuiAgent | null
  /** Whether this pane owns the tab's launch draft; false for split siblings. */
  ownsTabWideLaunchDraft: boolean
  /** Return this pane to the hosted terminal surface. */
  onSwitchToTerminal?: () => void
  /** Current xterm screen reader used to recover agent-reported session state. */
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}

export type NativeChatStructuredViewProps = NativeChatOrchestrationProps & {
  mode: 'structured'
  viewer?: boolean
  tabId: string
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
}

/** The agent process is gone; what the pane still knows for the next step. */
export type NativeChatAgentExit = {
  resumeRecord: SleepingAgentSessionRecord | null
  worktreeId: string | null
  hasUndeliveredPrompt: boolean
}

export type NativeChatResolvedViewProps = NativeChatOrchestrationProps & {
  paneKey: string
  /** Present once the launched agent has exited and the pane is back at a shell. */
  agentExit?: NativeChatAgentExit | null
  resumePending?: boolean
  agent: NativeChatSession['agent']
  sessionId: string | null
  transcriptPath: string | null
  isVisible: boolean
  transcriptLive: boolean
  targetPtyId: string | null
  terminalTabId: string
  ownsTabWideLaunchDraft: boolean
  onSwitchToTerminal?: () => void
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}

export type NativeChatViewProps = NativeChatBridgeViewProps | NativeChatStructuredViewProps
