import {
  OMNI_LEDGER_ATTEMPT_ID_ENV,
  OMNI_LEDGER_SESSION_ID_ENV
} from '../../../../shared/session-ledger-env'

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  // Why: PR 2778 briefly exported this path; keep deleting stale inherited values so older PTYs can't leak the reverted path.
  'ORCA_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

// Why: OmniConsole never sets these, so an inherited value means a pty host launched from inside a Claude session — Claude reads it as a nested child and silently stops persisting the transcript.
export const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID'
] as const

// Why: the ledger ids are per agent pane; a nested terminal must not report under its parent's row.
export const SESSION_LEDGER_ENV_KEYS = [
  OMNI_LEDGER_SESSION_ID_ENV,
  OMNI_LEDGER_ATTEMPT_ID_ENV
] as const
