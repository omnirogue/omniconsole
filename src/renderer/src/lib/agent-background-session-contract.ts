import type {
  AutomationLaunchPreferences,
  AutomationLaunchProvenanceRequest,
  AutomationOutputBindingRequest
} from '../../../shared/automations-types'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import type { AgentBackgroundResumeRequest } from '../../../shared/agent-resume-prompt-launch-plan'

export type LaunchAgentBackgroundSessionArgs = {
  launchPreferences?: AutomationLaunchPreferences
  automationLaunchProvenance?: AutomationLaunchProvenanceRequest
  automationOutputBinding?: AutomationOutputBindingRequest
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  launchSource?: LaunchSource
  title?: string
  onData?: (chunk: string) => void
  onExit?: (ptyId: string, code: number) => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
  /** Resume this provider thread instead of starting a new one; main verifies the
   *  thread's home before honoring it and starts fresh when it cannot. */
  resume?: AgentBackgroundResumeRequest
}

export type LaunchAgentBackgroundSessionResult = {
  tabId: string
  paneKey: string
  ptyId: string
  startupPlan: AgentStartupPlan
  promptDeliveryResult?: Promise<boolean>
  terminalOwnership: AutomationTerminalOwnership | null
}
