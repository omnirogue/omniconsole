import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveCodexStructuredAppServerArgs } from '../../../shared/codex-structured-app-server-args'
import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'

export type StructuredCodexHostSupport =
  | { supported: true }
  | { supported: false; reason: 'remote' | 'wsl' | 'windows' | 'repair-required' }

export type StructuredCodexLaunchFallbackReason =
  | 'agent'
  | 'chat-ui-off'
  | 'default-view-terminal'
  | 'structured-off'
  | 'remote'
  | 'wsl'
  | 'windows'
  | 'repair-required'
  | 'custom-args'
  | 'launch-env'
  | 'default-args'

export type StructuredCodexLaunchDecision =
  | { structured: true }
  | {
      structured: false
      reason: StructuredCodexLaunchFallbackReason
      /** The token or error that forced the fallback, when one did. */
      detail?: string
      /** True when the person had opted into structured chat, so the fallback deserves a word. */
      explain: boolean
    }

/**
 * Whether a Codex launch goes to the app-server runtime or a terminal-backed
 * chat. The rules mirror what the host can actually apply: configured default
 * arguments are translated (and refused visibly when they cannot be), model and
 * effort travel as launch options, and a prompt is queued for the first turn —
 * so none of those force the terminal path any more. What still does: a
 * per-launch argument override or account environment, and hosts the runtime
 * cannot supervise (remote, WSL, Windows).
 */
export function decideStructuredCodexLaunch(input: {
  agent: TuiAgent
  settings: Pick<
    GlobalSettings,
    | 'experimentalNativeChat'
    | 'openAgentTabsInChatByDefault'
    | 'experimentalStructuredNativeChat'
    | 'agentDefaultArgs'
  > | null
  /** Evaluated only once settings allow structured chat; host resolution is not free. */
  hostSupport: () => StructuredCodexHostSupport
  customAgentArgs: string | null | undefined
  launchEnv: Record<string, string> | null | undefined
  shell: AgentStartupShell
}): StructuredCodexLaunchDecision {
  if (input.agent !== 'codex') {
    return { structured: false, reason: 'agent', explain: false }
  }
  const settings = input.settings
  if (settings?.experimentalNativeChat === false) {
    return { structured: false, reason: 'chat-ui-off', explain: false }
  }
  if (settings?.openAgentTabsInChatByDefault !== true) {
    return { structured: false, reason: 'default-view-terminal', explain: false }
  }
  if (settings?.experimentalStructuredNativeChat !== true) {
    return { structured: false, reason: 'structured-off', explain: false }
  }
  const hostSupport = input.hostSupport()
  if (!hostSupport.supported) {
    return { structured: false, reason: hostSupport.reason, explain: true }
  }
  if (input.customAgentArgs?.trim()) {
    return {
      structured: false,
      reason: 'custom-args',
      detail: input.customAgentArgs.trim(),
      explain: true
    }
  }
  if (input.launchEnv && Object.keys(input.launchEnv).length > 0) {
    return {
      structured: false,
      reason: 'launch-env',
      detail: Object.keys(input.launchEnv).join(', '),
      explain: true
    }
  }
  const defaults = resolveTuiAgentLaunchArgs('codex', settings?.agentDefaultArgs)
  if (defaults.trim()) {
    try {
      resolveCodexStructuredAppServerArgs(defaults, input.shell)
    } catch (error) {
      return {
        structured: false,
        reason: 'default-args',
        detail: error instanceof Error ? error.message : String(error),
        explain: true
      }
    }
  }
  return { structured: true }
}
