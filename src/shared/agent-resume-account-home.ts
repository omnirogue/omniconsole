/**
 * Resumes a Claude or Codex conversation under the account home that holds its transcript.
 *
 * Why: a restored pane often has no recorded account (omni-launch-best picks it inside the
 * terminal), and a `claude` shell function may re-pin CLAUDE_CONFIG_DIR, so a bare resume line
 * lands in the default home and fails with "No conversation found". The home comes from the
 * transcript path, the same rule "Copy resume command" and `omni session resume` follow.
 */

import type { AgentProviderSessionMetadata } from './agent-session-resume'
import { conversationProfileOf } from './conversation-resume-command'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { resolveStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

type ResumePlanArgs = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentEnv?: Record<string, string> | null
  agentCommand?: string | null
}

const PROFILE_OVERRIDE_VARIABLES = {
  claude: ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME', 'ORCA_CODEX_HOME']
} as const

/**
 * The same resume-plan args, pinned to the transcript's account home. Unchanged when the agent is
 * not Claude/Codex or the transcript path does not name a home. Local panes only: the caller
 * decides, since a remote transcript path belongs to its own host's shell.
 */
export function pinAgentResumeAccountHome<T extends ResumePlanArgs>(
  args: T
): T & {
  bypassShellFunctions?: boolean
  accountConfigEnv?: Record<string, string>
} {
  const agent = args.agent
  const transcriptPath = args.providerSession.transcriptPath
  if ((agent !== 'claude' && agent !== 'codex') || !transcriptPath) {
    return args
  }
  const profile = conversationProfileOf(agent, transcriptPath)
  // Why Codex's default home is left alone: main routes it (runtime mirror, hooks) at spawn.
  if (!profile || (profile.isDefault && agent === 'codex')) {
    return args
  }
  const [variable, ...markers] = PROFILE_OVERRIDE_VARIABLES[agent]
  const agentEnv = { ...args.agentEnv }
  for (const name of [variable, ...markers]) {
    delete agentEnv[name]
  }
  // Why no variable for the default home: an explicit CLAUDE_CONFIG_DIR moves Claude onto a
  // different Keychain item, so the default is reached by clearing any inherited override.
  if (!profile.isDefault) {
    agentEnv[variable] = profile.path
  }
  const accountConfigEnv = { [variable]: profile.isDefault ? '' : profile.path }
  // Why drop the saved command: it is the bare line that resumed in the wrong home; rebuilding
  // it from the saved args is what lets the assignment and the function bypass reach the CLI.
  const pinned: T = { ...args }
  delete pinned.agentCommand
  return {
    ...pinned,
    agentEnv,
    // Why: `claude`/`codex` shell functions that re-pin a profile would undo the pinned home.
    ...(profile.isDefault ? {} : { bypassShellFunctions: true }),
    // Why on the line itself: a cold-restored pane types it into a shell that is already running,
    // so the spawn env never reaches it. Only POSIX shells take the inline form.
    ...(resolveStartupShell(args.platform, args.shell) === 'posix' ? { accountConfigEnv } : {})
  }
}
