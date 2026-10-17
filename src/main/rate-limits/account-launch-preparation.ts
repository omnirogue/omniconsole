import { claudeResumeConfigDir } from '../claude/claude-resume-identity'
import { claudeConfigDirEnvPatch } from '../claude/claude-config-dir-pin'
import { systemClaudeConfigDir } from './claude-seat-directory'
import { ensureClaudeHooksForRequestedEnv } from '../claude-accounts/account-directory-hooks'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { Store } from '../persistence'
import type { RateLimitService } from './service'
import { chooseAccountForLaunch } from '../../shared/account-launch-selection'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from '../claude-accounts/runtime-selection'
import {
  getSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from '../codex-accounts/runtime-selection'
import { prepareClaudeAccountSession } from '../claude-accounts/account-session-auth'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

export type ClaudeLaunchAccountOptions = {
  env?: NodeJS.ProcessEnv
  preserveAccount?: boolean
  resumeSession?: AgentProviderSessionMetadata
}

export async function prepareBalancedClaudeAccount(args: {
  store: Store
  rateLimits: RateLimitService
  target?: ClaudeAccountSelectionTarget
  options?: ClaudeLaunchAccountOptions
  fallback: () => Promise<ClaudeRuntimeAuthPreparation>
}): Promise<ClaudeRuntimeAuthPreparation> {
  const { store, rateLimits, options } = args
  const target = {
    runtime: args.target?.runtime ?? ('host' as const),
    wslDistro: args.target?.wslDistro ?? null
  }
  if (target.runtime === 'wsl') {
    return args.fallback()
  }
  const resumeHome = options?.resumeSession && claudeResumeConfigDir(options.resumeSession)
  const explicitPath = resumeHome || options?.env?.CLAUDE_CONFIG_DIR?.trim()
  if (!resumeHome && explicitPath === systemClaudeConfigDir() && !process.env.CLAUDE_CONFIG_DIR) {
    return args.fallback()
  }
  if (explicitPath) {
    const account = store
      .getSettings()
      .claudeManagedAccounts.find(
        (entry) =>
          entry.managedAuthRuntime !== 'wsl' &&
          (explicitPath === entry.managedAuthPath ||
            explicitPath === `${entry.managedAuthPath}/session` ||
            explicitPath === join(entry.managedAuthPath, 'session'))
      )
    if (account) {
      return prepareClaudeAccountSession(account, {
        preserveSessionDirectory: options?.preserveAccount,
        transcriptPath: options?.resumeSession?.transcriptPath
      })
    }
    ensureClaudeHooksForRequestedEnv({ CLAUDE_CONFIG_DIR: explicitPath })
    return {
      configDir: explicitPath,
      envPatch: claudeConfigDirEnvPatch(explicitPath),
      stripAuthEnv: true,
      provenance: `profile:${explicitPath}`
    }
  }
  if (options?.preserveAccount) {
    const transcript = options.resumeSession?.transcriptPath
    const account =
      transcript &&
      store.getSettings().claudeManagedAccounts.find((entry) => {
        if (entry.managedAuthRuntime === 'wsl') {
          return false
        }
        const inside = relative(join(entry.managedAuthPath, 'session', 'projects'), transcript)
        return (
          inside !== '' && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)
        )
      })
    return account
      ? prepareClaudeAccountSession(account, {
          preserveSessionDirectory: true,
          transcriptPath: transcript
        })
      : args.fallback()
  }
  void rateLimits.fetchInactiveClaudeAccountsOnOpen().catch(() => {})
  const settings = store.getSettings()
  const account = chooseAccountForLaunch({
    provider: 'claude',
    accounts: settings.claudeManagedAccounts,
    defaultAccountId: getSelectedClaudeAccountIdForTarget(settings, target),
    target,
    rateLimits: rateLimits.getState()
  })
  if (!account) {
    return args.fallback()
  }
  if (account.launchEnv) {
    const env = account.launchEnv
    return prepareBalancedClaudeAccount({ ...args, options: { ...options, env } })
  }
  return account ? prepareClaudeAccountSession(account) : args.fallback()
}

/**
 * The account a host model listing is filed under: the one settings select for this target (null:
 * the system default), read without refreshing usage, balancing, or setting an account up.
 */
export function selectedListingAccount(
  settings: Parameters<typeof getSelectedClaudeAccountIdForTarget>[0] &
    Parameters<typeof getSelectedCodexAccountIdForTarget>[0],
  agentId: 'claude' | 'codex',
  target: ClaudeAccountSelectionTarget
): string | null {
  return agentId === 'claude'
    ? getSelectedClaudeAccountIdForTarget(settings, target)
    : getSelectedCodexAccountIdForTarget(settings, target)
}

export async function chooseBalancedCodexAccount(args: {
  store: Store
  rateLimits: RateLimitService
  target?: CodexAccountSelectionTarget
}): Promise<string | null> {
  void args.rateLimits.fetchInactiveCodexAccountsOnOpen().catch(() => {})
  const settings = args.store.getSettings()
  const target = {
    runtime: args.target?.runtime ?? ('host' as const),
    wslDistro: args.target?.wslDistro ?? null
  }
  return (
    chooseAccountForLaunch({
      provider: 'codex',
      accounts: settings.codexManagedAccounts,
      defaultAccountId: getSelectedCodexAccountIdForTarget(settings, target),
      target,
      rateLimits: args.rateLimits.getState()
    })?.id ?? null
  )
}
