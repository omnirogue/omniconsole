import type { AgentLaunchPreferenceSelection } from '../../../../shared/agent-launch-preference-check'
import type { AgentTemplateText } from '../../../../shared/agent-template-dispatch'

/** A workspace made from a project: its first message opens with the line and carries the context. */
export type QuickLaunchProject = {
  line: string
  context: string
  /** The project's agent, used when no template was chosen. */
  agent: AgentTemplateText | null
}

/** Per-launch choices from Add Next; never saved as account defaults. */
export type QuickLaunchOptions = {
  onLaunched?: (worktreeId: string, tabId: string) => void
  preferences?: AgentLaunchPreferenceSelection
  submitPrompt?: boolean
  chatBypass?: boolean
  /** Agent template whose instructions lead the first message; absent means Default. */
  agentTemplateId?: string
  project?: QuickLaunchProject
}
