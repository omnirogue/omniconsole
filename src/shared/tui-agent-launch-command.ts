import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { applyLocalOmniConsoleCliLauncher } from './omniconsole-cli-launcher'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  isPosixStartupShell,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { ACCOUNT_OAUTH_TOKEN_FILE_ENV, isPoolOAuthTokenFile } from './session-prep-account'

export type ResolvedAgentLaunchCommand =
  | {
      ok: true
      command: string
      commandWithoutSessionOptions: string
      appliedSessionOptions: Record<string, SessionOptionValue>
    }
  | { ok: false; error: string }

export function resolveAgentLaunchCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
  /** Why: a launch that names an account must reach the CLI itself; a shell
   * function wrapping the agent (`function claude { … CLAUDE_CONFIG_DIR=… }`)
   * would silently re-pin the directory. `command` skips functions and aliases
   * in sh-family shells; an explicit command override always wins. */
  bypassShellFunctions?: boolean
  /** Host-verified profile paths and blank auth overrides, reapplied after shell rc files. */
  accountConfigEnv?: Record<string, string>
  /** Host-owned flag/value pairs (a project thread's memory settings). Unlike session options
   *  they stay in the resume command; a flag the person's own args or override pass is kept theirs. */
  pinnedFlags?: readonly (readonly [string, string])[]
}): ResolvedAgentLaunchCommand {
  const override = args.cmdOverrides[args.agent]
  // Why: the default command names the OmniConsole CLI by absolute path on a local
  // POSIX host, so a namesake `omni` earlier on the login shell's PATH cannot win.
  const baseCommand = applyLocalOmniConsoleCliLauncher(
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    }),
    { platform: args.platform, shell: args.shell, isRemote: args.isRemote }
  )
  let command =
    override ||
    ((args.bypassShellFunctions || (args.agent === 'omp' && args.sessionOptions?.model)) &&
    isPosixStartupShell(args.shell)
      ? `command ${baseCommand}`
      : baseCommand)
  if (args.accountConfigEnv && Object.keys(args.accountConfigEnv).length > 0) {
    if (!isPosixStartupShell(args.shell)) {
      return { ok: false, error: 'Verified SSH account launches require a POSIX shell.' }
    }
    const { [ACCOUNT_OAUTH_TOKEN_FILE_ENV]: tokenFile, ...accountEnv } = args.accountConfigEnv
    const entries = Object.entries(accountEnv)
    if (entries.some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\0\r\n]/.test(value))) {
      return { ok: false, error: 'Invalid execution-host account environment.' }
    }
    if (tokenFile !== undefined && !isPoolOAuthTokenFile(tokenFile)) {
      return { ok: false, error: 'Invalid execution-host account token file.' }
    }
    // Why unset, not KEY='': an empty value means "clear the inherited override", but Claude
    // reads CLAUDE_CONFIG_DIR='' as the config directory "" (signed out, no settings, first-run
    // menus). Measured on mw0002, 2026-09-26: SSH launches of the default profile stalled there.
    const cleared = entries.filter(([, value]) => value === '').map(([key]) => key)
    const assignments = entries
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `${key}=${quoteStartupArg(value, args.shell)}`)
    if (tokenFile !== undefined) {
      // Why expansion on the host: the pool token stays in that Mac's file; only its path crosses.
      assignments.push(`CLAUDE_CODE_OAUTH_TOKEN="$(cat ${quoteStartupArg(tokenFile, args.shell)})"`)
    }
    // Apply on the invocation itself: shell startup may have replaced the PTY spawn environment.
    command = [cleared.length > 0 ? `unset ${cleared.join(' ')};` : '', ...assignments, command]
      .filter(Boolean)
      .join(' ')
  }
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  const trailingTokens = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : { ok: true as const, tokens: [], spans: [] }
  if (!trailingTokens.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${trailingTokens.error}` }
  }
  const givenOverride = override ? tokenizeStartupCommand(override, args.shell) : null
  const pinned = pinnedFlagArgs(args.pinnedFlags, [
    ...trailingTokens.tokens,
    ...(givenOverride?.ok ? givenOverride.tokens : [])
  ])
  if (pinned.length > 0) {
    command = `${command} ${pinned.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')}`
  }
  const resolvedOptions = resolveAgentSessionOptionLaunch(
    args.agent,
    args.sessionOptions,
    args.sessionOptionsOverrideAgentArgs ? [] : trailingTokens.tokens,
    !args.sessionOptionsOverrideAgentArgs
  )
  if (override && args.sessionOptionsOverrideAgentArgs) {
    const overrideTokens = tokenizeStartupCommand(override, args.shell)
    if (!overrideTokens.ok) {
      return { ok: false, error: `Agent command override is invalid: ${overrideTokens.error}` }
    }
    const commandOverrideOptions = resolveAgentSessionOptionLaunch(
      args.agent,
      args.sessionOptions,
      overrideTokens.tokens,
      false
    )
    if (
      Object.entries(resolvedOptions.appliedValues).some(
        ([key, value]) => commandOverrideOptions.appliedValues[key] !== value
      )
    ) {
      return {
        ok: false,
        error:
          'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
      }
    }
  }
  const optionSuffix = resolvedOptions.args.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')
  const commandWithoutSessionOptions = suffix.suffix ? `${command} ${suffix.suffix}` : command
  const commandWithOptions = optionSuffix ? `${command} ${optionSuffix}` : command
  const overrideTokens = args.sessionOptionsOverrideAgentArgs
    ? insertBeforeTerminator(
        removeOverriddenAgentSessionArgs(args.agent, args.sessionOptions, trailingTokens.tokens),
        resolvedOptions.args
      )
    : []
  const commandWithOverrides = overrideTokens.length
    ? `${command} ${overrideTokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')}`
    : command
  return {
    ok: true,
    command: args.sessionOptionsOverrideAgentArgs
      ? commandWithOverrides
      : suffix.suffix
        ? `${commandWithOptions} ${suffix.suffix}`
        : commandWithOptions,
    commandWithoutSessionOptions,
    appliedSessionOptions: resolvedOptions.appliedValues
  }
}

function insertBeforeTerminator(tokens: readonly string[], inserted: readonly string[]): string[] {
  const terminator = tokens.indexOf('--')
  if (terminator === -1) {
    return [...tokens, ...inserted]
  }
  return [...tokens.slice(0, terminator), ...inserted, ...tokens.slice(terminator)]
}

function pinnedFlagArgs(
  flags: readonly (readonly [string, string])[] | undefined,
  given: readonly string[]
): string[] {
  return (flags ?? [])
    .filter(([flag]) => !given.some((token) => token === flag || token.startsWith(`${flag}=`)))
    .flatMap(([flag, value]) => [flag, value])
}
