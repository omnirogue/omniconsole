import { execFileSync } from 'node:child_process'
import { runProcess } from '../../shared/child-process/run-process'

const PROCESS_TABLE_LOOKUP_TIMEOUT_MS = 250
const PROCESS_TABLE_QUERY_TIMEOUT_MS = PROCESS_TABLE_LOOKUP_TIMEOUT_MS / 2
const PROCESS_TABLE_MAX_BYTES = 64 * 1024

export type PosixPtyForegroundGroupDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: () => string
}

type ProcessRow = {
  pid: number
  tpgid: number
  tty: string
}

/** `ps` prints `ttys003` / `pts/3`; node-pty reports `/dev/ttys003` / `/dev/pts/3`. */
function normalizeTty(value: string): string {
  return value.replace(/^\/dev\//, '')
}

function hasUsableTty(tty: string): boolean {
  return tty !== '?' && tty !== '??' && tty !== '-'
}

function runPs(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'pid=,tpgid=,tty='], {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_QUERY_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_MAX_BYTES
  })
}

/**
 * Why two calls instead of `-p a,b`: macOS `ps` only takes the KERN_PROC_PID fast
 * path for a single pid. ANY pid list — even a duplicate of one pid — walks the
 * whole process table, measured at ~3.6s on a busy machine versus ~3ms here. That
 * blew the timeout below, so the group lookup silently fell back to the very
 * root-pid delivery this module exists to replace.
 */
function readForegroundGroupTable(rootPid: number, currentPid: number): string {
  return `${runPs(rootPid)}\n${runPs(currentPid)}`
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (pid > 0) {
      rows.push({ pid, tpgid: Number(match[2]), tty: match[3] })
    }
  }
  return rows
}

/**
 * Resolves the foreground process group of one PTY, which is who the kernel
 * signals on a real window-size change.
 *
 * Why not the root pid: the shell calls `setpgid` for job control, so it leaves
 * the root's group immediately, and on macOS the root is `login(1)` — which
 * neither handles nor forwards SIGWINCH. A foreground TUI is a third group
 * again, so only the tty's `tpgid` reproduces a kernel resize.
 */
export function getPosixPtyForegroundGroup(
  output: string,
  rootPid: number,
  ptsName: string,
  currentPid = process.pid
): number | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || !hasUsableTty(root.tty)) {
    return null
  }
  // Why: `ps -p` answers for whatever owns the pid now. Without pinning the tty we
  // captured at spawn, a recycled pid could aim a group signal at a real terminal.
  if (normalizeTty(root.tty) !== normalizeTty(ptsName)) {
    return null
  }
  // Why: a development daemon can inherit its launch TTY. Never group-signal when
  // this process shares the PTY; fall back to the already-scoped root signal.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  // tpgid is -1 when no foreground group owns the tty, and pid 1 is never one.
  return root.tpgid > 1 ? root.tpgid : null
}

/**
 * One process as `omni session` pins its receiver: its group, its tty, that tty's foreground group
 * and its start time. The ONE start-time source for that pin: the binding, every re-proof and every
 * guarded write (in main or the terminal daemon) read the same `ps` field, `lstart`, in the C locale
 * and UTC, so the two sides of each comparison are the same reading.
 */
export type PosixReceiverRow = {
  pgid: number
  tpgid: number
  tty: string
  startTimeMs: number | null
  stat?: string
  command?: string
}

/** `lstart` has one-second precision: the margin between two readings of that same field. */
export const PS_LSTART_TOLERANCE_MS = 1_000

const LSTART_MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec'

/** `Thu Sep 24 16:11:12 2026`, printed under TZ=UTC, as epoch ms; null for any other shape. */
export function parsePsLstartUtc(text: string): number | null {
  const match =
    /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
      text.trim()
    )
  const month = match ? LSTART_MONTHS.indexOf(match[1]!) : -1
  if (!match || month < 0 || month % 3 !== 0) {
    return null
  }
  const [year, day, hour, minute, second] = [6, 2, 3, 4, 5].map((index) => Number(match[index]))
  return Date.UTC(year!, month / 3, day!, hour!, minute!, second!)
}

function parsePosixProcessRow(output: string, pid: number): PosixReceiverRow | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+?)\s*$/m.exec(output)
  if (!match || Number(match[1]) !== pid) {
    return null
  }
  const detail =
    /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(\S+)\s+(.+))?$/.exec(
      match[5]!
    )
  return {
    pgid: Number(match[2]),
    tpgid: Number(match[3]),
    tty: match[4]!,
    startTimeMs: parsePsLstartUtc(detail?.[1] ?? match[5]!),
    ...(detail?.[2] ? { stat: detail[2], command: detail[3] } : {})
  }
}

export function parsePosixReceiverRow(output: string, pid: number): PosixReceiverRow | null {
  const row = parsePosixProcessRow(output, pid)
  return row && hasUsableTty(row.tty) ? row : null
}

/** Capture birth before the spawned child has necessarily acquired its controlling TTY. */
export function readPosixSpawnRootRowSync(
  pid: number
): Pick<PosixReceiverRow, 'tty' | 'startTimeMs'> | null {
  const row = readPosixProcessRowSync(pid)
  return row ? { tty: row.tty, startTimeMs: row.startTimeMs } : null
}

/** Read synchronously with one single-pid `ps` (the fast path; see `readForegroundGroupTable`). */
export function readPosixReceiverRowSync(pid: number): PosixReceiverRow | null {
  const row = readPosixProcessRowSync(pid)
  return row && hasUsableTty(row.tty) ? row : null
}

const RECEIVER_ROW_FORMAT = 'pid=,pgid=,tpgid=,tty=,lstart=,stat=,command='

// Why: one fixed format and zone, whatever the locale or TZ of main or the daemon.
function receiverRowEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
}

function readPosixProcessRowSync(pid: number): PosixReceiverRow | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', RECEIVER_ROW_FORMAT], {
      encoding: 'utf8',
      timeout: PROCESS_TABLE_QUERY_TIMEOUT_MS,
      maxBuffer: PROCESS_TABLE_MAX_BYTES,
      env: receiverRowEnv()
    })
    return parsePosixProcessRow(output, pid)
  } catch {
    return null
  }
}

/**
 * The same single-pid reading as `readPosixReceiverRowSync`, without blocking the event loop:
 * macOS `ps` takes 60-80 ms on a busy machine even on its fast path (#857).
 */
export async function readPosixReceiverRow(pid: number): Promise<PosixReceiverRow | null> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-p', String(pid), '-o', RECEIVER_ROW_FORMAT],
      // Why the whole budget: nothing waits on this synchronously, and a busy loop delays the exit.
      timeoutMs: PROCESS_TABLE_LOOKUP_TIMEOUT_MS,
      maxOutputBytes: PROCESS_TABLE_MAX_BYTES,
      env: receiverRowEnv()
    })
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return null
    }
    const row = parsePosixProcessRow(result.stdout, pid)
    return row && hasUsableTty(row.tty) ? row : null
  } catch {
    return null
  }
}

/**
 * Sends `signal` to the PTY's foreground process group, falling back to the
 * supplied root-pid delivery when the group cannot be established safely.
 *
 * Scoped to SIGWINCH by callers on purpose: a destructive signal must keep the
 * narrower root-pid target plus the descendant-sweep identity machinery.
 */
export function signalPosixPtyForegroundGroup(
  rootPid: number,
  ptsName: string | undefined,
  signal: NodeJS.Signals | (string & {}),
  fallback: () => void,
  deps: PosixPtyForegroundGroupDeps = {}
): void {
  if ((deps.platform ?? process.platform) === 'win32' || !ptsName) {
    fallback()
    return
  }
  const currentPid = deps.currentPid ?? process.pid
  let pgid: number | null
  try {
    pgid = getPosixPtyForegroundGroup(
      (deps.readProcessTable ?? (() => readForegroundGroupTable(rootPid, currentPid)))(),
      rootPid,
      ptsName,
      currentPid
    )
  } catch {
    pgid = null
  }
  if (pgid === null) {
    fallback()
    return
  }
  try {
    process.kill(-pgid, signal as NodeJS.Signals)
  } catch (error) {
    // Why: the group can exit between `ps` and `kill`. The fallback would be just
    // as stale, so a vanished foreground group is success, not a reason to retry.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') {
      fallback()
    }
  }
}
