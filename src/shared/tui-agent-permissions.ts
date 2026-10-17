import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type RestrictedTuiAgentPreset = 'plan' | 'read-only' | 'approve'
export type AgentPermissionMode = 'yolo' | RestrictedTuiAgentPreset | 'manual' | 'mixed'
export type SelectableAgentPermissionMode = Exclude<AgentPermissionMode, 'mixed'>

export const YOLO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
  antigravity: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  kiro: '--trust-all-tools',
  crush: '--yolo',
  autohand: '--unrestricted',
  cline: '--auto-approve true',
  'command-code': '--yolo',
  continue: '--allow "*"',
  cursor: '--yolo',
  kimi: '--yolo',
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

/**
 * Why a separate map, not a YOLO_TUI_AGENT_ARGS entry: YOLO_TUI_AGENT_ARGS doubles
 * as DEFAULT_TUI_AGENT_ARGS (tui-agent-launch-defaults.ts) — every agent listed
 * there gets that string as its DEFAULT launch args, applied even when nobody
 * asked for yolo. OMP's own un-flagged default is already yolo (`tools.approvalMode`,
 * per `omp --help` on the installed 18.2.0 CLI; see omp-approval-overlay.ts), so
 * folding `--yolo` into the defaults map would make OMP yolo by default again —
 * exactly the silent-yolo behavior the permission catalog exists to prevent. Keep
 * OMP's entry here instead: consulted only by the explicit Bypass launch path
 * (chatBypassLaunchTokens in chat-launch-permissions.ts) and by
 * getTuiAgentArgsForPermissionMode's 'yolo' case, never by the defaults resolver.
 */
export const BYPASS_ONLY_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  omp: '--yolo'
}

const CLAUDE_PLAN_ARGS = '--permission-mode plan'
const GROK_PLAN_ARGS = '--permission-mode plan'
const GEMINI_PLAN_ARGS = '--approval-mode plan'
const CODEX_READ_ONLY_ARGS = '-s read-only -a never'

export const RESTRICTED_TUI_AGENT_ARGS: Record<
  RestrictedTuiAgentPreset,
  Partial<Record<TuiAgent, string>>
> = {
  plan: {
    claude: CLAUDE_PLAN_ARGS,
    'claude-agent-teams': CLAUDE_PLAN_ARGS,
    openclaude: CLAUDE_PLAN_ARGS,
    antigravity: CLAUDE_PLAN_ARGS,
    grok: GROK_PLAN_ARGS,
    gemini: GEMINI_PLAN_ARGS
    // Codex `codex --help` has no plan mode; `-s read-only -a never` is the read-only preset.
  },
  'read-only': {
    // Claude/Grok have no dedicated read-only mode; `--permission-mode plan` is the closest.
    claude: CLAUDE_PLAN_ARGS,
    'claude-agent-teams': CLAUDE_PLAN_ARGS,
    openclaude: CLAUDE_PLAN_ARGS,
    antigravity: CLAUDE_PLAN_ARGS,
    grok: GROK_PLAN_ARGS,
    gemini: GEMINI_PLAN_ARGS,
    codex: CODEX_READ_ONLY_ARGS
  },
  approve: {}
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

export function isTuiAgentPermissionTarget(agent: TuiAgent): boolean {
  return agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
}

function normalizeArgs(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function sameEnv(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) {
    return false
  }
  return leftEntries.every(([name, value]) => right?.[name] === value)
}

export function getTuiAgentArgsForPermissionMode(
  agent: TuiAgent,
  mode: SelectableAgentPermissionMode
): string {
  if (mode === 'yolo') {
    return YOLO_TUI_AGENT_ARGS[agent] ?? BYPASS_ONLY_TUI_AGENT_ARGS[agent] ?? ''
  }
  if (mode === 'plan' || mode === 'read-only') {
    return RESTRICTED_TUI_AGENT_ARGS[mode][agent] ?? ''
  }
  return ''
}

function isManagedAgentArgs(agent: TuiAgent, args: string): boolean {
  return (
    args === getTuiAgentArgsForPermissionMode(agent, 'yolo') ||
    args === getTuiAgentArgsForPermissionMode(agent, 'plan') ||
    args === getTuiAgentArgsForPermissionMode(agent, 'read-only') ||
    args === getTuiAgentArgsForPermissionMode(agent, 'approve')
  )
}

function resolveAgentPermissionMode(agent: TuiAgent, args: string): AgentPermissionMode {
  const yoloArgs = getTuiAgentArgsForPermissionMode(agent, 'yolo')
  if (yoloArgs && args === yoloArgs) {
    return 'yolo'
  }
  const planArgs = getTuiAgentArgsForPermissionMode(agent, 'plan')
  if (planArgs && args === planArgs) {
    return 'plan'
  }
  const readOnlyArgs = getTuiAgentArgsForPermissionMode(agent, 'read-only')
  if (readOnlyArgs && args === readOnlyArgs) {
    return 'read-only'
  }
  if (!args) {
    return 'manual'
  }
  return 'mixed'
}

function resolveAgentEnvPermissionMode(
  env: Record<string, string> | null | undefined,
  yoloEnv: Record<string, string> | undefined
): AgentPermissionMode {
  if (sameEnv(env, {})) {
    return 'manual'
  }
  return sameEnv(env, yoloEnv) ? 'yolo' : 'mixed'
}

function combinePermissionModes(modes: AgentPermissionMode[]): AgentPermissionMode {
  const unique = new Set<AgentPermissionMode>()
  for (const mode of modes) {
    unique.add(mode === 'approve' ? 'manual' : mode)
  }

  if (unique.has('mixed')) {
    return 'mixed'
  }

  // Why: empty flags are manual; a yolo/manual mix is mixed, not yolo.
  if (unique.has('yolo')) {
    return unique.size === 1 ? 'yolo' : 'mixed'
  }

  unique.delete('manual')
  if (unique.size === 0) {
    return 'manual'
  }
  if (unique.has('plan') && unique.has('read-only')) {
    return unique.size === 2 ? 'read-only' : 'mixed'
  }
  if (unique.size === 1) {
    const [mode] = unique
    return mode ?? 'manual'
  }
  return 'mixed'
}

export function resolveTuiAgentPermissionMode(args: {
  agent: TuiAgent
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []
  if (args.agent in YOLO_TUI_AGENT_ARGS) {
    modes.push(resolveAgentPermissionMode(args.agent, normalizeArgs(args.agentArgs)))
  }
  if (args.agent in YOLO_TUI_AGENT_ENV) {
    modes.push(resolveAgentEnvPermissionMode(args.agentEnv, YOLO_TUI_AGENT_ENV[args.agent]))
  }

  return combinePermissionModes(modes)
}

export function resolvePublishedTuiAgentPermissionMode(args: {
  agent?: TuiAgent | null
  launchConfig?: {
    agentArgs?: string | null
    agentEnv?: Record<string, string> | null
  } | null
}): AgentPermissionMode | undefined {
  if (!args.agent || !args.launchConfig || !isTuiAgentPermissionTarget(args.agent)) {
    return undefined
  }
  return resolveTuiAgentPermissionMode({
    agent: args.agent,
    agentArgs: args.launchConfig.agentArgs,
    agentEnv: args.launchConfig.agentEnv
  })
}

export function resolveAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []

  for (const agent of PERMISSION_AGENT_IDS) {
    modes.push(
      resolveTuiAgentPermissionMode({
        agent,
        agentArgs: args.agentDefaultArgs?.[agent],
        agentEnv: args.agentDefaultEnv?.[agent]
      })
    )
  }

  return combinePermissionModes(modes)
}

export function applyAgentPermissionMode(args: {
  mode: SelectableAgentPermissionMode
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const nextArgs = { ...args.agentDefaultArgs }
  const nextEnv = { ...args.agentDefaultEnv }

  for (const agent of PERMISSION_AGENT_IDS) {
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const currentArgs = normalizeArgs(nextArgs[agent])
      if (isManagedAgentArgs(agent, currentArgs)) {
        nextArgs[agent] = getTuiAgentArgsForPermissionMode(agent, args.mode)
      }
    }

    if (agent in YOLO_TUI_AGENT_ENV) {
      const yoloEnv = YOLO_TUI_AGENT_ENV[agent]
      const currentEnv = nextEnv[agent]
      if (sameEnv(currentEnv, {}) || sameEnv(currentEnv, yoloEnv)) {
        nextEnv[agent] = args.mode === 'yolo' ? { ...yoloEnv } : {}
      }
    }
  }

  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
