import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import type { ClaudeLaunchAccountOptions } from '../rate-limits/account-launch-preparation'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { parseWslUncPath } from '../../shared/wsl-paths'

export type CommitMessageAgentEnvironmentResolvers = {
  prepareForCodexLaunch?: (
    target?: CommitMessageAgentRuntimeTarget,
    env?: NodeJS.ProcessEnv
  ) => string | null | Promise<string | null>
  prepareForClaudeLaunch?: (
    target?: CommitMessageAgentRuntimeTarget,
    options?: ClaudeLaunchAccountOptions
  ) => Promise<ClaudeRuntimeAuthPreparation>
  /**
   * The account settings select for this target (null: the system default), read without setting
   * one up or balancing to another. Why: a host model listing is looked up by it before the
   * account is prepared; without it, the account is prepared first on every listing.
   */
  listingAccount?: (
    agentId: 'claude' | 'codex',
    target: CommitMessageAgentRuntimeTarget
  ) => string | null
}

export type CommitMessageAgentRuntimeTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

// Why: with system-default real-home routing, the headless Codex commit run
// must use the user's own ~/.codex. If OmniConsole itself was launched from a nested
// OmniConsole terminal it can inherit an OmniConsole-owned CODEX_HOME override; strip only
// that (CODEX_HOME matching the private ORCA_CODEX_HOME marker), preserving a
// user-set CODEX_HOME.
function cloneProcessEnvWithoutOrcaCodexHomeOverride(): Record<string, string> {
  const env = cloneProcessEnv()
  if (env.ORCA_CODEX_HOME && env.CODEX_HOME === env.ORCA_CODEX_HOME) {
    delete env.CODEX_HOME
  }
  delete env.ORCA_CODEX_HOME
  return env
}

function readInheritedOrShellEnvVar(name: string, sourceName?: string): string | undefined {
  return (
    (sourceName ? process.env[sourceName] : undefined) ??
    process.env[name] ??
    readShellStartupEnvVar(name, process.env.HOME, process.env.SHELL)
  )
}

function prepareShellConfigDirEnv(agentId: string): { ok: true; env?: NodeJS.ProcessEnv } | null {
  const configVar =
    agentId === 'opencode'
      ? 'OPENCODE_CONFIG_DIR'
      : agentId === 'pi' || agentId === 'omp'
        ? 'PI_CODING_AGENT_DIR'
        : agentId === 'grok'
          ? 'GROK_HOME'
          : null
  if (!configVar) {
    return null
  }
  // Why: each kind owns a distinct ORCA_*_SOURCE_* shadow so a headless commit
  // run from inside a legacy OMP overlay restores the OMP source dir, never
  // the Pi one (and vice versa). PI_CODING_AGENT_DIR is the binary-facing var
  // both kinds consume — see src/main/pi/titlebar-extension-service.ts.
  const sourceVar =
    agentId === 'opencode'
      ? 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'ORCA_PI_SOURCE_AGENT_DIR'
        : agentId === 'omp'
          ? 'ORCA_OMP_SOURCE_AGENT_DIR'
          : undefined

  const value = readInheritedOrShellEnvVar(configVar, sourceVar)
  if (!value) {
    return { ok: true }
  }

  // Why: GUI-launched OmniConsole may not inherit shell startup exports, but these
  // vars point the headless CLI at the user's auth/config root. Nested OmniConsole
  // launches inherit PTY overlays, so prefer ORCA_*_SOURCE_* when present.
  return { ok: true, env: { ...cloneProcessEnv(), [configVar]: value } }
}

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  target?: CommitMessageAgentRuntimeTarget,
  accountEnv?: NodeJS.ProcessEnv
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  // Why: a non-null result short-circuits the resolvers below, so any agent added
  // to prepareShellConfigDirEnv must not also need a Codex/Claude-style resolver.
  const shellConfigEnv = target?.runtime === 'wsl' ? null : prepareShellConfigDirEnv(agentId)
  if (agentId === 'omp' && target?.runtime !== 'wsl') {
    const env = { ...(await resolveLoginShellEnvironment()), ...accountEnv }
    const source =
      process.env.ORCA_OMP_SOURCE_AGENT_DIR ??
      env.ORCA_OMP_SOURCE_AGENT_DIR ??
      env.PI_CODING_AGENT_DIR ??
      shellConfigEnv?.env?.PI_CODING_AGENT_DIR
    return { ok: true, env: { ...env, ...(source ? { PI_CODING_AGENT_DIR: source } : {}) } }
  }
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  if (!resolvers) {
    return { ok: true }
  }

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = await (accountEnv
        ? resolvers.prepareForCodexLaunch(target, accountEnv)
        : resolvers.prepareForCodexLaunch(target))
      const wslCodexHome = codexHomePath ? parseWslUncPath(codexHomePath) : null
      if (target?.runtime === 'wsl') {
        const codexHomeForTarget = wslCodexHome?.linuxPath ?? null
        // Why: the fallback must still strip OmniConsole-owned overrides, or a
        // system-default WSL run inherits the managed CODEX_HOME.
        return {
          ok: true,
          env: codexHomeForTarget
            ? { ...cloneProcessEnvWithoutOrcaCodexHomeOverride(), CODEX_HOME: codexHomeForTarget }
            : cloneProcessEnvWithoutOrcaCodexHomeOverride()
        }
      }
      if (codexHomePath && wslCodexHome) {
        // Why: this local generation path spawns the host Codex binary. A WSL
        // managed home is only valid when the process is routed through wsl.exe.
        return { ok: true }
      }
      return {
        ok: true,
        env: codexHomePath
          ? { ...cloneProcessEnv(), CODEX_HOME: codexHomePath }
          : cloneProcessEnvWithoutOrcaCodexHomeOverride()
      }
    }

    if (agentId === 'claude' && resolvers.prepareForClaudeLaunch) {
      const preparation = await (accountEnv
        ? resolvers.prepareForClaudeLaunch(target, { env: accountEnv })
        : resolvers.prepareForClaudeLaunch(target))
      const env = applyClaudeEnvPatch(cloneProcessEnv(), preparation.envPatch, {
        stripAuthEnv: preparation.stripAuthEnv
      })
      return { ok: true, env }
    }
  } catch (error) {
    console.error('[commit-message] Failed to prepare agent environment:', error)
    return {
      ok: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    }
  }

  return { ok: true }
}
