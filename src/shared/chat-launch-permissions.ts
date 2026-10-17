import { nativeChatEnabledByPreference } from './native-chat-preference'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import type { GlobalSettings } from './global-settings-types'
import {
  getTuiAgentArgsForPermissionMode,
  BYPASS_ONLY_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'
import {
  applyOmpApprovalOverlayArgs,
  getOmpApprovalOverlayConfigPath
} from './omp-approval-overlay'
import {
  tokenizeStartupCommand,
  quoteStartupArg,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

/** Override permission switches only; keep model, effort, account and unrelated arguments. */
export function chatBypassLaunchTokens(
  agent: TuiAgent,
  tokens: readonly string[],
  mode: 'yolo' | 'read-only' = 'yolo'
): string[] {
  // Why BYPASS_ONLY_TUI_AGENT_ARGS too: OMP's `--yolo` lives there, not in
  // YOLO_TUI_AGENT_ARGS, because YOLO_TUI_AGENT_ARGS also backs DEFAULT_TUI_AGENT_ARGS
  // and OMP's un-flagged default is already yolo (see omp-approval-overlay.ts) — this
  // explicit Bypass launch path is the one place that string is allowed to apply.
  const bypass =
    mode === 'read-only'
      ? getTuiAgentArgsForPermissionMode(agent, mode)
      : (YOLO_TUI_AGENT_ARGS[agent] ?? BYPASS_ONLY_TUI_AGENT_ARGS[agent])
  if (mode === 'read-only' && !bypass) {
    throw new Error(
      'This agent does not support unattended read-only routines. Choose an agent with read-only support or explicitly allow write actions.'
    )
  }
  if (!bypass) {
    return [...tokens]
  }
  const parsed = tokenizeStartupCommand(bypass, 'posix')
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const values = new Set(['--permission-mode', '--approval-mode', '--auto-approve'])
  if (agent === 'codex') {
    ;['-a', '--ask-for-approval', '-s', '--sandbox'].forEach((flag) => values.add(flag))
  }
  if (agent === 'droid') {
    values.add('--auto')
  }
  if (agent === 'mistral-vibe') {
    values.add('--agent')
  }
  const flags = new Set([
    '--full-auto',
    '--yolo',
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-allow-all',
    '--trust-all-tools',
    '--yes-always',
    '--unrestricted'
  ])
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--') {
      kept.push(...parsed.tokens, ...tokens.slice(i))
      return kept
    }
    const name = token.split('=')[0]!
    if (flags.has(name)) {
      continue
    }
    if (values.has(name)) {
      if (!token.includes('=')) {
        i++
      }
      continue
    }
    if (agent === 'codex' && (name === '-c' || name === '--config')) {
      const config = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[i + 1]
      if (/^(?:approval_policy|sandbox_mode)\s*=/.test(config ?? '')) {
        if (!token.includes('=')) {
          i++
        }
        continue
      }
    }
    kept.push(token)
  }
  return [...kept, ...parsed.tokens]
}

export function chatBypassLaunchArgs(
  agent: TuiAgent,
  args: string | null | undefined,
  shell: AgentStartupShell = 'posix',
  mode: 'yolo' | 'read-only' = 'yolo'
): string {
  const parsed = tokenizeStartupCommand(args ?? '', shell)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  if (parsed.spans.some((span) => span.divergesFromShell)) {
    throw new Error('The agent arguments could not be read for this chat launch.')
  }
  return chatBypassLaunchTokens(agent, parsed.tokens, mode)
    .map((token) => (/^[A-Za-z0-9_./:=,-]+$/.test(token) ? token : quoteStartupArg(token, shell)))
    .join(' ')
}

export function chatBypassLaunchEnv(
  agent: TuiAgent,
  env: Record<string, string>
): Record<string, string> {
  return { ...env, ...YOLO_TUI_AGENT_ENV[agent] }
}

/** Session-scoped defaults for UI launch paths; never writes the settings object. */
export function resolveChatLaunchDefaults(
  agent: TuiAgent,
  settings:
    | Pick<
        GlobalSettings,
        | 'experimentalNativeChat'
        | 'openAgentTabsInChatByDefault'
        | 'agentDefaultArgs'
        | 'agentDefaultEnv'
      >
    | null
    | undefined,
  shell: AgentStartupShell = 'posix',
  chatLaunch?: boolean
) {
  const agentArgs = resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv)
  const isBypass =
    chatLaunch ??
    (nativeChatEnabledByPreference(settings) && settings?.openAgentTabsInChatByDefault === true)
  if (isBypass) {
    return {
      agentArgs: chatBypassLaunchArgs(agent, agentArgs, shell),
      agentEnv: chatBypassLaunchEnv(agent, agentEnv)
    }
  }
  // Why: OMP's own un-flagged default is yolo (see omp-approval-overlay.ts); every
  // launch that isn't the Bypass preset must still get an explicit non-yolo
  // approval mode, never OMP's silent default.
  if (agent === 'omp') {
    return {
      agentArgs: applyOmpApprovalOverlayArgs(agentArgs, getOmpApprovalOverlayConfigPath(), shell),
      agentEnv
    }
  }
  return { agentArgs, agentEnv }
}
