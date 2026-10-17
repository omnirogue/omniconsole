import type { LaunchTrigger } from '../../../shared/launch-trigger'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { AgentLaunchPreferenceSelection } from '../../../shared/agent-launch-preference-check'

/** An end outcome chosen at launch; it becomes the submitted prompt with outcome discovery on. */
export type LaunchAgentOutcome = {
  /** What must be true when this conversation is done. */
  text: string
  /** When the user turned on "Plan the team"; absent binds the outcome without a team. */
  teamPlanConsentedAt?: string
}

export type LaunchAgentInNewTabArgs = {
  /** Keep a pane launch in its current grid; default preserves launcher navigation. */
  navigate?: boolean
  /** The ready submission's stable identity, also used by host-side create replay. */
  submissionId?: string
  onSessionCreated?: (tabId: string) => void
  conversationLauncher?: boolean
  outcome?: LaunchAgentOutcome
  /** Parent omnios card; bound through the task prompt, since task env needs an admitted work plan. */
  hubTaskId?: string
  /** Internal retry after an ACP probe refusal; preserves the normal PTY launch. */
  acpFallback?: boolean
  agent: TuiAgent
  worktreeId: string
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  initialCwd?: string | null
  /** How to deliver the prompt: `draft` leaves it editable, `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchTrigger?: LaunchTrigger
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Shell platform for the startup command; defaults to renderer OS. SSH/WSL worktrees run Linux even from Windows. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
  /** Model and effort for this launch only; callers validate through checkAgentLaunchPreferences first. */
  launchPreferences?: AgentLaunchPreferenceSelection | null
  /** Extra environment for this session only (an account profile's config directory). Never persisted. */
  launchEnv?: Record<string, string> | null
  /** Per-launch Chat / Terminal choice (a saved favourite); replaces the global default-view setting. */
  viewModePreference?: 'chat' | 'terminal'
  /** Replace this still-pending renderer reservation immediately before publishing its PTY tab. */
  reservedConversationTabId?: string
  /** Requested tab id, so a caller can later find the tab this launch created (assisted-brief Start). */
  tabId?: string
}

export type LaunchAgentInNewTabResult = {
  tabId: string | null
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  /** The host will publish and focus a structured tab asynchronously. */
  focusAfterMenuClose?: 'structured-session'
  /** Host publication outcome, including launches without an initial prompt. */
  launchCompletion?: Promise<boolean>
  launchOutcome?: Promise<'started' | 'failed' | 'uncertain'>
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
} | null

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.tabId === null && result.focusAfterMenuClose !== 'structured-session'
}
