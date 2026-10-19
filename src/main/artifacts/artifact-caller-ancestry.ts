/**
 * Where a CLI process sits relative to a pane's proven agent, read from one process table: under
 * it (nothing but tools in between), not under it (another agent or app in between, or the chain
 * ends elsewhere), or unknown (the table does not name the caller, the agent or a parent).
 */

import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { getFirstCommandToken } from '../../shared/command-token-scanner'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

export type CallerAncestry = 'under' | 'not-under' | 'unknown'

const MAX_ANCESTRY_DEPTH = 128
// Why: a macOS app's own executable (Antigravity, Cursor, a browser) is never the agent's tool call.
const APP_BUNDLE_EXECUTABLE = /^(\/(?:[^/\s]+\/)*)[^/]+\.app\/Contents\/MacOS\/([^/\s]+)/
// Why: framework builds of these re-exec as `….app/Contents/MacOS/<name>` (Homebrew and Xcode python3).
const INTERPRETER = /^(?:python[\d.]*|node|bun|ruby|perl[\d.]*|bash|zsh|sh)$/i
/** Launchers whose own agent runs as their direct child under another name. */
const WRAPPED_AGENT: Readonly<Record<string, string>> = { 'claude-agent-teams': 'claude' }

function isOtherApp(command: string, selfExecutable: string): boolean {
  // Why: OmniConsole's own CLI runs from its app bundle; it is a tool, not another app.
  if (command === selfExecutable || command.startsWith(`${selfExecutable} `)) {
    return false
  }
  const app = APP_BUNDLE_EXECUTABLE.exec(command)
  return app !== null && !app[1]!.includes('.framework/') && !INTERPRETER.test(app[2]!)
}

function agentLike(command: string, selfExecutable: string): string | null {
  const agent = recognizeAgentProcessFromCommandLine(command, { includeHeadlessOneShot: true })
  return agent?.agent ?? (isOtherApp(command, selfExecutable) ? 'app' : null)
}

/** The agent's own process under its launcher: Codex's npm `node` wrapper, the Agent Teams wrapper. */
function launchedBy(
  nested: string,
  parent: ProcessTableRow,
  agent: { pid: number; agent: string | null },
  agentRow: ProcessTableRow
): boolean {
  if (parent.ppid !== agent.pid || !agent.agent) {
    return false
  }
  const interpreted = isAgentForegroundWrapperProcess(getFirstCommandToken(agentRow.command))
  return (interpreted && nested === agent.agent) || WRAPPED_AGENT[agent.agent] === nested
}

export function callerAncestry(
  rows: readonly ProcessTableRow[],
  callerPid: number,
  agent: { pid: number; agent: string | null },
  selfExecutable: string = process.execPath
): CallerAncestry {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const agentRow = byPid.get(agent.pid)
  let current = byPid.get(callerPid)
  if (!agentRow || !current || callerPid === agent.pid) {
    return 'unknown'
  }
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (current.ppid === agent.pid) {
      return 'under'
    }
    // Why stop at 0/1 and self-loops: init reparenting ends every chain there.
    if (current.ppid <= 1 || current.ppid === current.pid) {
      return 'not-under'
    }
    const parent = byPid.get(current.ppid)
    if (!parent) {
      return 'unknown'
    }
    const nested = agentLike(parent.command, selfExecutable)
    if (nested !== null && !launchedBy(nested, parent, agent, agentRow)) {
      return 'not-under'
    }
    current = parent
  }
  return 'unknown'
}

/** True when `rootPid`'s tree holds a recognised agent, or a process its hooks reported. */
export function paneTreeHasAgent(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  hookPids: readonly (number | null)[]
): boolean {
  const children = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  }
  const pending = rows.filter((row) => row.pid === rootPid)
  const seen = new Set<number>()
  while (pending.length > 0) {
    const row = pending.pop()!
    if (seen.has(row.pid)) {
      continue
    }
    seen.add(row.pid)
    if (
      hookPids.includes(row.pid) ||
      recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })
    ) {
      return true
    }
    pending.push(...(children.get(row.pid) ?? []))
  }
  return false
}
