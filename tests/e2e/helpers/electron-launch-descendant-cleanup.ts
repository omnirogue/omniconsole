import type { ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

type Identity = {
  pid: number
  startedAt: string
  uid: number
  group: number
  session: number
  executable: string
}

type Candidate = Identity & { pipes: readonly string[] }
export type LaunchCleanupSnapshot = {
  launcher: Identity
  candidates: readonly Candidate[]
}

function identity(pid: number): Identity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]
    if (!uid || !fields[19]) {
      return undefined
    }
    return {
      pid,
      startedAt: fields[19],
      uid: Number(uid),
      group: Number(fields[2]),
      session: Number(fields[3]),
      executable: readlinkSync(`/proc/${pid}/exe`)
    }
  } catch {
    return undefined
  }
}

function pipeTargets(pid: number): string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`)
      .slice(0, 4096)
      .flatMap((fd) => {
        try {
          const target = readlinkSync(`/proc/${pid}/fd/${fd}`)
          return /^(?:pipe|socket):\[\d+\]$/.test(target) ? [target] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function sameIdentity(first: Identity, second: Identity | undefined): boolean {
  return (
    second !== undefined &&
    first.pid === second.pid &&
    first.startedAt === second.startedAt &&
    first.uid === second.uid &&
    first.group === second.group &&
    first.session === second.session &&
    first.executable === second.executable
  )
}

/** Freeze ownership while the actual Playwright launcher still owns its Linux session. */
export function captureElectronLaunchDescendants(
  proc: ChildProcess
): LaunchCleanupSnapshot | undefined {
  if (process.platform !== 'linux' || !proc.pid) {
    return undefined
  }
  const launcher = identity(proc.pid)
  if (
    !launcher ||
    launcher.group !== launcher.pid ||
    launcher.session !== launcher.pid ||
    launcher.uid !== process.getuid?.() ||
    launcher.executable !== realpathSync(proc.spawnfile)
  ) {
    throw new Error('Cannot establish disposable Electron launch ownership')
  }
  const inherited = new Set(
    proc.stdio.flatMap((_stream, fd) => {
      try {
        const target = readlinkSync(`/proc/${launcher.pid}/fd/${fd}`)
        return /^(?:pipe|socket):\[\d+\]$/.test(target) ? [target] : []
      } catch {
        return []
      }
    })
  )
  const candidates: Candidate[] = []
  for (const entry of readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .slice(0, 4096)) {
    const pid = Number(entry)
    if (pid <= 1 || [launcher.pid, process.pid, process.ppid].includes(pid)) {
      continue
    }
    const current = identity(pid)
    if (
      !current ||
      current.uid !== launcher.uid ||
      current.group !== launcher.pid ||
      current.session !== launcher.pid ||
      BigInt(current.startedAt) < BigInt(launcher.startedAt)
    ) {
      continue
    }
    const pipes = pipeTargets(pid).filter((target) => inherited.has(target))
    if (pipes.length && sameIdentity(current, identity(pid))) {
      candidates.push(Object.freeze({ ...current, pipes: Object.freeze(pipes) }))
    }
  }
  if (!sameIdentity(launcher, identity(launcher.pid))) {
    throw new Error('Disposable Electron launcher changed during ownership capture')
  }
  return Object.freeze({ launcher: Object.freeze(launcher), candidates: Object.freeze(candidates) })
}

function stillOwned(candidate: Candidate): boolean {
  return (
    sameIdentity(candidate, identity(candidate.pid)) &&
    pipeTargets(candidate.pid).some((target) => candidate.pipes.includes(target))
  )
}

function sameBirthStillAlive(candidate: Identity): boolean {
  try {
    const stat = readFileSync(`/proc/${candidate.pid}/stat`, 'utf8')
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    return fields[19] === candidate.startedAt && fields[0] !== 'Z' && fields[0] !== 'X'
  } catch {
    return false
  }
}

async function waitForExit(candidate: Candidate): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!sameBirthStillAlive(candidate)) {
      return true
    }
    await delay(100)
  }
  return !sameBirthStillAlive(candidate)
}

/** Call only after final fixture disposal; warm-restart PTYs must remain alive between launches. */
export async function cleanupElectronLaunchDescendants(
  proc: ChildProcess,
  snapshot: LaunchCleanupSnapshot | undefined
): Promise<{ matched: number[]; exited: number[] }> {
  const receipt = { matched: [] as number[], exited: [] as number[] }
  if (!snapshot) {
    return receipt
  }
  if (proc.pid !== snapshot.launcher.pid || (proc.exitCode === null && proc.signalCode === null)) {
    throw new Error('Refusing descendant cleanup before its exact Electron launcher exits')
  }
  for (const candidate of snapshot.candidates) {
    if (!stillOwned(candidate)) {
      continue
    }
    receipt.matched.push(candidate.pid)
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      // Recheck the frozen process identity AND its inherited launch pipe before each signal.
      if (!sameBirthStillAlive(candidate)) {
        break
      }
      if (!stillOwned(candidate)) {
        throw new Error(
          `Disposable Electron descendant ${candidate.pid} survived but lost its signal guard`
        )
      }
      try {
        process.kill(candidate.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          break
        }
        throw error
      }
      if (await waitForExit(candidate)) {
        break
      }
    }
    if (sameBirthStillAlive(candidate)) {
      throw new Error(`Disposable Electron descendant ${candidate.pid} did not exit`)
    }
    receipt.exited.push(candidate.pid)
  }
  return receipt
}
