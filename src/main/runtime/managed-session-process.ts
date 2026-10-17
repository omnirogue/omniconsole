import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import {
  getFreshProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { readProcessStartTimesMs } from './agent-session-process-identity-probe'

export type ManagedSessionProvider = 'claude' | 'codex'
export type ManagedSessionProcess = {
  pid: number
  startTimeMs: number
  provider: ManagedSessionProvider
  rootPid: number
  rootStartTimeMs: number
  live: true
}

type ProcessReadDeps = {
  platform?: NodeJS.Platform
  readRows?: () => Promise<ProcessTableRow[]>
  readBirths?: (pids: readonly number[]) => Promise<Map<number, number | null>>
}

function recognizedLive(
  row: ProcessTableRow | undefined,
  provider: ManagedSessionProvider
): boolean {
  return Boolean(
    row &&
    row.stat.includes('+') &&
    !/[TZ]/.test(row.stat) &&
    recognizeAgentProcessFromCommandLine(row.command)?.agent === provider
  )
}

function exactRows(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  pid: number,
  provider: ManagedSessionProvider
): { root: ProcessTableRow; agent: ProcessTableRow } | null {
  if (
    rows.filter((row) => row.pid === rootPid).length !== 1 ||
    rows.filter((row) => row.pid === pid).length !== 1
  ) {
    return null
  }
  const root = rows.find((row) => row.pid === rootPid)!
  const agent = rows.find((row) => row.pid === pid)!
  if (!recognizedLive(root, provider) || !recognizedLive(agent, provider)) {
    return null
  }
  return pid === rootPid ? { root, agent } : null
}

/** Managed launches exec the native provider itself; descendants cannot inherit its authority. */
export async function readManagedSessionProcess(
  gate: PtyLaunchGateReceipt,
  provider: ManagedSessionProvider,
  pid: number,
  deps: ProcessReadDeps = {}
): Promise<ManagedSessionProcess | null> {
  if (
    (deps.platform ?? process.platform) !== 'darwin' ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid !== gate.pid
  ) {
    return null
  }
  try {
    const readRows = deps.readRows ?? getFreshProcessTableSnapshot
    const before = exactRows(await readRows(), gate.pid, pid, provider)
    if (!before) {
      return null
    }
    const births = await (deps.readBirths ?? readProcessStartTimesMs)([gate.pid, pid])
    const rootBirth = births.get(gate.pid)
    const birth = births.get(pid)
    if (
      !Number.isSafeInteger(rootBirth) ||
      !Number.isSafeInteger(birth) ||
      (birth as number) <= 0 ||
      (rootBirth as number) <= 0 ||
      Math.floor(rootBirth! / 1000) !== Math.floor(gate.processStartTimeMs / 1000) ||
      birth! < rootBirth!
    ) {
      return null
    }
    const after = exactRows(await readRows(), gate.pid, pid, provider)
    if (
      !after ||
      after.root.command !== before.root.command ||
      after.agent.command !== before.agent.command ||
      after.root.ppid !== before.root.ppid ||
      after.agent.ppid !== before.agent.ppid
    ) {
      return null
    }
    const confirmed = await (deps.readBirths ?? readProcessStartTimesMs)([gate.pid, pid])
    if (confirmed.get(gate.pid) !== rootBirth || confirmed.get(pid) !== birth) {
      return null
    }
    return {
      pid,
      startTimeMs: birth!,
      provider,
      rootPid: gate.pid,
      rootStartTimeMs: gate.processStartTimeMs,
      live: true
    }
  } catch {
    return null
  }
}
