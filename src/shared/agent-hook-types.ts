// Why: shared agent-hook IPC payload shapes and the managed-script protocol
// version constant. Consumed by both the main-process hook server (src/main/
// agent-hooks/server.ts) and each per-agent hook service. Lives in `shared/`
// to keep a single source of truth for the version string and status contract.

export const AGENT_HOOK_TARGETS = [
  'claude',
  'openclaude',
  'codex',
  'gemini',
  'antigravity',
  'amp',
  'cursor',
  'droid',
  'command-code',
  'grok',
  'copilot',
  'hermes',
  'devin',
  'kimi',
  'qwen-code'
] as const
export type AgentHookTarget = (typeof AGENT_HOOK_TARGETS)[number]

export type AgentHookInstallState = 'installed' | 'not_installed' | 'partial' | 'error' | 'skipped'

export type AgentHookInstallSkipReason =
  | 'agent_disabled'
  | 'cli_not_found'
  | 'cli_presence_unknown'
  | 'hooks_disabled'

export type AgentHookInstallStatus = {
  agent: AgentHookTarget
  state: AgentHookInstallState
  configPath: string
  managedHooksPresent: boolean
  detail: string | null
  skipReason?: AgentHookInstallSkipReason
}

// Additive PID ownership metadata; old scripts remain accepted.
export const ORCA_HOOK_PROTOCOL_VERSION = '2' as const
/** v1 scripts (no agent PID fields) stay fully supported; only unknown versions are stale. */
export const ORCA_HOOK_COMPATIBLE_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '1',
  ORCA_HOOK_PROTOCOL_VERSION
])

// Why: absence means the listener predates raw-JSON metadata headers, so managed scripts must keep using form posts.
export const ORCA_HOOK_RAW_JSON_TRANSPORT = 'raw-json-v1' as const
