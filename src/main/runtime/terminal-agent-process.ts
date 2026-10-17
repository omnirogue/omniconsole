/**
 * Which process holds a terminal's foreground as its agent, by process id, from the process table:
 * the proof `omni session continue|ask` binds a queued prompt to, and re-checks before each write.
 *
 * A process counts when it sits in the terminal's foreground process group (`+` in `ps stat`),
 * descends from the PTY's own root process, and its command line is a recognized agent's. A hook PID alone
 * cannot identify an agent: it may have been reused since the report. A shell, a stopped job, another
 * program, or an agent that replaced the original one (a different pid or start time) never does.
 */

import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import { getFirstCommandToken } from '../../shared/command-token-scanner'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { PS_LSTART_TOLERANCE_MS, type PosixReceiverRow } from '../pty/posix-pty-foreground-group'
import type {
  TerminalAgentProcessProof,
  TerminalProcessTree
} from '../../shared/pty-agent-process-evidence'
export type {
  TerminalAgentProcessProof,
  TerminalProcessTree
} from '../../shared/pty-agent-process-evidence'

export type CodexCompletionReporter = { pid: number; completedAt: number; incarnation: string }

/** A persisted reporter is only a candidate; re-prove the native child of this live wrapper. */
export function proveCompletedCodexReporter(
  rows: readonly ProcessTableRow[],
  ordinary: TerminalAgentProcessProof,
  ordinaryRow: PosixReceiverRow,
  candidate: CodexCompletionReporter,
  readReceiver: (pid: number) => PosixReceiverRow | null
): TerminalAgentProcessProof | null {
  const wrapper = rows.find((row) => row.pid === ordinary.pid)
  const native = rows.find((row) => row.pid === candidate.pid)
  const executable = (command: string) => getFirstCommandToken(command).split(/[\\/]/).pop()
  if (
    ordinary.agent !== 'codex' ||
    !ordinary.incarnationId ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid < 2 ||
    !Number.isFinite(candidate.completedAt) ||
    candidate.completedAt <= 0 ||
    !wrapper ||
    !native ||
    native.ppid !== wrapper.pid ||
    executable(wrapper.command) !== 'node' ||
    !executable(native.command)?.startsWith('codex') ||
    rows.some(
      (row) =>
        row.ppid === wrapper.pid &&
        row.pid !== candidate.pid &&
        inForeground(row) &&
        recognizeAgentProcessFromCommandLine(row.command) !== null
    )
  ) {
    return null
  }
  const found = findForegroundAgentProcess(rows, ordinary.rootPid, candidate.pid)
  if (found?.pid !== candidate.pid || found.agent !== 'codex') {
    return null
  }
  const current = readReceiver(candidate.pid)
  const start = current?.startTimeMs
  return current &&
    start !== null &&
    start !== undefined &&
    Number.isFinite(start) &&
    start >= ordinary.startTimeMs &&
    start <= candidate.completedAt &&
    current.stat?.includes('+') &&
    !current.stat.includes('T') &&
    recognizeAgentProcessFromCommandLine(current.command ?? '')?.agent === 'codex' &&
    current.tty === ordinaryRow.tty &&
    current.pgid === ordinary.pgid &&
    current.pgid === current.tpgid
    ? { ...ordinary, ...found, startTimeMs: start }
    : null
}

function inForeground(row: ProcessTableRow): boolean {
  return row.stat.includes('+')
}

/** Every process under `rootPid`, found once from the table. */
function descendantsOf(
  rows: readonly ProcessTableRow[],
  rootPid: number
): (ProcessTableRow & { parentAgent: boolean })[] {
  const children = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      children.set(row.ppid, [row])
    }
  }
  const found: (ProcessTableRow & { parentAgent: boolean })[] = []
  const pending = (children.get(rootPid) ?? []).map((row) => ({ row, parentAgent: false }))
  const seen = new Set<number>([rootPid])
  while (pending.length > 0) {
    const { row, parentAgent } = pending.pop()!
    if (seen.has(row.pid)) {
      continue
    }
    seen.add(row.pid)
    found.push({ ...row, parentAgent })
    const agent = inForeground(row) && recognizeAgentProcessFromCommandLine(row.command) !== null
    for (const child of children.get(row.pid) ?? []) {
      pending.push({ row: child, parentAgent: agent })
    }
  }
  return found
}

/** The foreground agent process under `rootPid`, or null when none is proven. */
export function findForegroundAgentProcess(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  reporterPid: number | null
): Pick<TerminalAgentProcessProof, 'pid' | 'agent' | 'via'> | null {
  const tree = descendantsOf(rows, rootPid)
  // A stopped job (Ctrl-Z) leaves the foreground unproven either way.
  if (tree.some((row) => row.stat.includes('T'))) {
    return null
  }
  const foreground = tree.filter(inForeground)
  const reporter =
    reporterPid === null ? undefined : foreground.find((row) => row.pid === reporterPid)
  const reportedAgent = reporter && recognizeAgentProcessFromCommandLine(reporter.command)?.agent
  if (reporter && reportedAgent) {
    return {
      pid: reporter.pid,
      agent: reportedAgent,
      via: 'hook-report'
    }
  }
  // The outermost recognized process: a wrapper (node …/codex) lives as long as its agent.
  for (const row of foreground) {
    const agent = row.parentAgent ? null : recognizeAgentProcessFromCommandLine(row.command)?.agent
    if (agent) {
      return { pid: row.pid, agent, via: 'command-line' }
    }
  }
  return null
}

/** The bound agent process still holds this PTY's foreground: same pid, same start, same tree. */
export function agentProcessStillHolds(
  rows: readonly ProcessTableRow[],
  proof: Pick<TerminalAgentProcessProof, 'rootPid' | 'pid' | 'startTimeMs'>,
  observedStartTimeMs: number | null
): boolean {
  const row = descendantsOf(rows, proof.rootPid).find((candidate) => candidate.pid === proof.pid)
  if (
    !row ||
    !inForeground(row) ||
    row.stat.includes('T') ||
    !recognizeAgentProcessFromCommandLine(row.command)
  ) {
    return false
  }
  return (
    observedStartTimeMs !== null &&
    Math.abs(observedStartTimeMs - proof.startTimeMs) <= PS_LSTART_TOLERANCE_MS
  )
}

/**
 * What the process table sampled now says about the agent under this PTY, for exit: `agent-gone`
 * only when no agent (by command line, or the pid its hooks name) is left in the tree, stopped
 * jobs included, and only shells hold the foreground; a stopped job of any kind stays `stopped`.
 */
export function classifyTerminalProcessTree(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  reporterPid: number | null
): TerminalProcessTree {
  const tree = descendantsOf(rows, rootPid)
  // Why the root too: a shell that exec'd its agent leaves the agent as the PTY's own process.
  const root = rows.find((row) => row.pid === rootPid)
  if (!root) {
    return { kind: 'other' }
  }
  const all = [root, ...tree]
  if (all.some((row) => row.stat.includes('T'))) {
    return { kind: 'stopped' }
  }
  const agentLeft = all.some(
    (row) => row.pid === reporterPid || recognizeAgentProcessFromCommandLine(row.command) !== null
  )
  const foreground = all.filter(inForeground)
  const onlyShellsInFront =
    foreground.length > 0 && foreground.every((row) => isShellProcess(executableOf(row.command)))
  return !agentLeft && onlyShellsInFront ? { kind: 'agent-gone' } : { kind: 'other' }
}

/** `-zsh` (a login shell) and `/bin/zsh -il` both name zsh. */
function executableOf(command: string): string {
  const first = (command.trim().split(/\s+/, 1)[0] ?? '').replace(/^-/, '')
  return first.split(/[\\/]/).pop() ?? first
}
