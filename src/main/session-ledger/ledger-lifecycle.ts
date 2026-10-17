import { normalizeHookEventName } from '../../shared/agent-hook-listener/provider-event-names'
import { agentWriteToolOp, writeTargetPath } from '../../shared/agent-write-tools'
import { LEDGER_DETAIL_LIMITS, type LedgerEventDetail } from '../../shared/session-ledger-contract'

/** What the ledger reads off one accepted hook status (any provider, local or relayed). */
export type LedgerHookObservation = {
  hookEventName?: string
  toolName?: string
  toolInput?: string
  toolAgentType?: string
}

const SHELL_TOOLS = new Set([
  'Bash',
  'bash',
  'Execute',
  'run_shell_command',
  'run_command',
  'exec_command',
  'shell_command',
  'run_terminal_cmd',
  'run_terminal_command',
  'terminal',
  'powershell',
  'execute_code',
  'shell'
])

const TURN_END_EVENTS = new Set(['stop', 'stop_failure', 'after_agent', 'agent_end'])
// Pi/OMP emits both proposal and execution-start hooks; record each tool attempt only once.
const TOOL_START_EVENTS = new Set(['pre_tool_use', 'before_tool', 'tool_execution_start'])

const TOOL_END_EVENTS = new Set(['post_tool_use', 'after_tool', 'tool_execution_end'])
// Why: the git verbs that move HEAD to a new commit; the observer confirms by reading HEAD.
const GIT_HEAD_MOVING =
  /(?:^|[\s;&|(])git\b[^|;&]*?\s(?:commit|merge|rebase|cherry-pick|revert|am)\b/

/** True when a finished shell tool ran a git verb that may have produced a commit. */
export function isCompletedGitCommit(observation: LedgerHookObservation): boolean {
  const eventName = normalizeHookEventName(observation.hookEventName)
  const toolName = observation.toolName?.trim() ?? ''
  return (
    TOOL_END_EVENTS.has(eventName) &&
    SHELL_TOOLS.has(toolName) &&
    GIT_HEAD_MOVING.test(observation.toolInput ?? '')
  )
}

/** True for hooks that only end something; they never reopen an ended attempt. */
export function isEndingHook(hookEventName: string | undefined): boolean {
  const eventName = normalizeHookEventName(hookEventName)
  return TURN_END_EVENTS.has(eventName) || eventName === 'session_end'
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** Bare program names only: a token with quotes, `$(`, braces or other shell syntax is not a label. */
const PROGRAM_NAME = /^[A-Za-z0-9._+@-]{1,64}$/

/** The command's program name only — never its arguments (contract §3: no arguments). */
export function shellCommandTarget(command: string | undefined): string {
  if (!command) {
    return ''
  }
  const tokens = command.trim().split(/\s+/)
  // Why: `FOO=1 cmd` and `sudo cmd` name the program second; the target is the program.
  const program =
    tokens.find(
      (token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && token !== 'sudo' && token !== 'env'
    ) ?? ''
  const base = program.split(/[\\/]/).pop() ?? ''
  return PROGRAM_NAME.test(base) ? clip(base, LEDGER_DETAIL_LIMITS.target) : ''
}

export { writeTargetPath }

/**
 * Provider lifecycle → ledger events (contract §8). Pure: the caller emits the row's
 * start events itself and publishes paths through `publishPath`.
 */
export function mapHookToLedgerEvents(
  observation: LedgerHookObservation,
  options: { publishPath: (rawPath: string) => string }
): LedgerEventDetail[] {
  const eventName = normalizeHookEventName(observation.hookEventName)
  if (TURN_END_EVENTS.has(eventName)) {
    return [{ kind: 'stop', detail: { reason: 'turn_end' } }]
  }
  if (eventName === 'session_end') {
    return [{ kind: 'stop', detail: { reason: 'exit' } }]
  }
  if (eventName === 'subagent_stop') {
    return [
      {
        kind: 'tool_call',
        detail: {
          tool: 'subagent',
          target: clip(observation.toolAgentType?.trim() || 'subagent', LEDGER_DETAIL_LIMITS.target)
        }
      }
    ]
  }
  if (!TOOL_START_EVENTS.has(eventName)) {
    return []
  }
  const toolName = observation.toolName?.trim()
  if (!toolName) {
    return []
  }
  const op = agentWriteToolOp(toolName)
  if (op) {
    const rawPath = writeTargetPath(observation.toolInput)
    if (!rawPath) {
      // Why: a write with no clean path is still a tool call; the payload never becomes a path.
      return [{ kind: 'tool_call', detail: { tool: clip(toolName, LEDGER_DETAIL_LIMITS.tool) } }]
    }
    return [{ kind: 'file_write', detail: { path: options.publishPath(rawPath), op } }]
  }
  if (SHELL_TOOLS.has(toolName)) {
    const target = shellCommandTarget(observation.toolInput)
    return [{ kind: 'tool_call', detail: { tool: 'bash', ...(target ? { target } : {}) } }]
  }
  return [{ kind: 'tool_call', detail: { tool: clip(toolName, LEDGER_DETAIL_LIMITS.tool) } }]
}

/**
 * Which teardown produced the stop (contract §8). `remote-lost`: a pane whose process runs on
 * another host lost contact or was closed here — the execution host owns the process, so this
 * is `close`, never `exit` (docs/reference/ssh-execution-boundary.md).
 */
export type LedgerTeardownCause = 'pty-exit' | 'tab-close' | 'remote-lost' | 'quit'

export function stopReasonForTeardown(cause: LedgerTeardownCause): 'exit' | 'close' | 'quit' {
  switch (cause) {
    case 'pty-exit':
      return 'exit'
    case 'tab-close':
    case 'remote-lost':
      return 'close'
    case 'quit':
      return 'quit'
  }
}
