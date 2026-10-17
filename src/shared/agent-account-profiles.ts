import type { ClaudeManagedAccount, CodexManagedAccount } from './managed-account-types'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/**
 * A named account profile: the config directory a CLI reads its own sign-in from.
 * Only the path is stored — never a credential. The hub owns rotation and cooldown;
 * the IDE only lets a person pick which directory a launch starts with.
 */
export type AgentAccountProfile = {
  id: string
  label: string
  agent: TuiAgent
  /** Absolute path the agent's config-directory variable is set to for the launch. */
  configDir: string
}

/** The environment variable each CLI reads its config directory from. */
export const AGENT_ACCOUNT_CONFIG_DIR_ENV: Partial<Record<TuiAgent, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  // Why: `omni claude-teams` runs Claude Code with the pane's environment, so the lead signs in from the same directory.
  'claude-agent-teams': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME'
}

/** The CLI whose saved accounts a launch mode uses; the Agent Teams lead is Claude Code. */
function accountOwnerAgent(agent: TuiAgent): TuiAgent {
  return agent === 'claude-agent-teams' ? 'claude' : agent
}

export function agentSupportsAccountProfiles(agent: TuiAgent): boolean {
  return Boolean(AGENT_ACCOUNT_CONFIG_DIR_ENV[agent])
}

/** Whether a profile can be saved under `agent`. A launch mode that borrows another CLI's
 *  sign-in (Agent Teams uses Claude's) resolves those profiles but is never a separate owner. */
export function isAccountProfileOwnerAgent(agent: TuiAgent): boolean {
  return agentSupportsAccountProfiles(agent) && accountOwnerAgent(agent) === agent
}

export type AgentAccountChoice = {
  /** `managed:<account id>` or `profile:<profile id>`; stable across restarts. */
  id: string
  label: string
  kind: 'managed' | 'profile'
  env: Record<string, string>
}

export type AgentAccountSettings = {
  claudeManagedAccounts?: ClaudeManagedAccount[]
  codexManagedAccounts?: CodexManagedAccount[]
  agentAccountProfiles?: AgentAccountProfile[]
}

export const MANAGED_ACCOUNT_CHOICE_PREFIX = 'managed:'
export const PROFILE_ACCOUNT_CHOICE_PREFIX = 'profile:'

export function normalizeAgentAccountProfiles(value: unknown): AgentAccountProfile[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const profiles: AgentAccountProfile[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const configDir = typeof record.configDir === 'string' ? record.configDir.trim() : ''
    if (!id || !label || !configDir || !isTuiAgent(record.agent) || seen.has(id)) {
      continue
    }
    if (!agentSupportsAccountProfiles(record.agent)) {
      continue
    }
    seen.add(id)
    profiles.push({ id, label, agent: record.agent, configDir })
  }
  return profiles
}

function managedChoices(settings: AgentAccountSettings, agent: TuiAgent): AgentAccountChoice[] {
  const envVar = AGENT_ACCOUNT_CONFIG_DIR_ENV[agent]
  if (!envVar) {
    return []
  }
  if (accountOwnerAgent(agent) === 'claude') {
    // Why: WSL-hosted accounts point at a Linux path the host terminal cannot open.
    return (settings.claudeManagedAccounts ?? [])
      .filter((account) => account.managedAuthRuntime !== 'wsl' && account.managedAuthPath)
      .map((account) => ({
        id: `${MANAGED_ACCOUNT_CHOICE_PREFIX}${account.id}`,
        label: account.email,
        kind: 'managed' as const,
        env: { [envVar]: `${account.managedAuthPath}/session` }
      }))
  }
  if (agent === 'codex') {
    return (settings.codexManagedAccounts ?? [])
      .filter((account) => account.managedHomeRuntime !== 'wsl' && account.managedHomePath)
      .map((account) => ({
        id: `${MANAGED_ACCOUNT_CHOICE_PREFIX}${account.id}`,
        label: account.workspaceLabel
          ? `${account.email} (${account.workspaceLabel})`
          : account.email,
        kind: 'managed' as const,
        env: { [envVar]: account.managedHomePath }
      }))
  }
  return []
}

/** Every account a launch of `agent` may start under, managed accounts first. */
export function listAgentAccountChoices(
  settings: AgentAccountSettings | null | undefined,
  agent: TuiAgent
): AgentAccountChoice[] {
  const envVar = AGENT_ACCOUNT_CONFIG_DIR_ENV[agent]
  if (!settings || !envVar) {
    return []
  }
  const owner = accountOwnerAgent(agent)
  const profiles = (settings.agentAccountProfiles ?? [])
    .filter((profile) => accountOwnerAgent(profile.agent) === owner)
    .map((profile) => ({
      id: `${PROFILE_ACCOUNT_CHOICE_PREFIX}${profile.id}`,
      label: profile.label,
      kind: 'profile' as const,
      env: { [envVar]: profile.configDir }
    }))
  return [...managedChoices(settings, agent), ...profiles]
}

/**
 * The session-only environment for a chosen account, or undefined for the default
 * account. A choice that no longer exists resolves to undefined as well: launching
 * under the default account is the truthful fallback, and the caller can tell the
 * person the profile is gone.
 */
export function resolveAgentAccountLaunchEnv(
  settings: AgentAccountSettings | null | undefined,
  agent: TuiAgent,
  choiceId: string | null | undefined
): Record<string, string> | undefined {
  if (!choiceId) {
    return undefined
  }
  return listAgentAccountChoices(settings, agent).find((choice) => choice.id === choiceId)?.env
}
