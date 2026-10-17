import { realpathSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcessSync } from '../../../src/shared/child-process/run-process'

type ProcessIdentity = { startedAt: string; executable: string; command: string }

function readPs(args: string[]): string {
  const result = runProcessSync({ program: 'ps', args, timeoutMs: 2_000 })
  if (result.code !== 0) {
    throw new Error('Could not read Crashpad process identity')
  }
  return result.stdout.trim()
}

function canonicalPath(value: string): string | undefined {
  if (!path.isAbsolute(value)) {
    return undefined
  }
  try {
    return realpathSync.native(value)
  } catch {
    return undefined
  }
}

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const identity = readPs(['-ww', '-p', String(pid), '-o', 'lstart=,comm='])
    const match = /^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(identity)
    if (!match) {
      return undefined
    }
    // Why: Linux comm is truncated; procfs identifies the executable actually running.
    const executable = process.platform === 'linux' ? canonicalPath(`/proc/${pid}/exe`) : match[2]
    if (!executable) {
      return undefined
    }
    const command = readPs(['-ww', '-p', String(pid), '-o', 'command='])
    return { startedAt: match[1], executable, command }
  } catch {
    return undefined
  }
}

function ownsCrashpad(identity: ProcessIdentity, executable: string, database: string): boolean {
  if (canonicalPath(identity.executable) !== executable) {
    return false
  }
  // ps prints executable paths and argument values containing spaces without quotes.
  const commandExecutable = /^(.*?)\s+--/.exec(identity.command)?.[1]
  if (!commandExecutable || canonicalPath(commandExecutable) !== executable) {
    return false
  }
  const databases = [
    ...identity.command.matchAll(/(?:^|\s)--database=(.*?)(?=\s--[a-zA-Z0-9_-]+(?:=|\s|$)|$)/g)
  ]
  return databases.length === 1 && canonicalPath(databases[0][1]) === database
}

function sameProcess(first: ProcessIdentity, second: ProcessIdentity | undefined): boolean {
  return (
    second !== undefined &&
    first.startedAt === second.startedAt &&
    first.executable === second.executable &&
    first.command === second.command
  )
}

async function waitForIdentityToExit(pid: number, identity: ProcessIdentity): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!sameProcess(identity, readProcessIdentity(pid))) {
      return true
    }
    await delay(100)
  }
  return !sameProcess(identity, readProcessIdentity(pid))
}

/** Release only this disposable profile's detached helper, after its Electron root has exited. */
export async function cleanupE2EProfileCrashpad(
  userDataDir: string,
  electronExecutable: string
): Promise<void> {
  const events: unknown[] = []
  const record = (event: string, detail: object = {}): void => {
    events.push({ event, ...detail })
  }
  const receipt = (): void =>
    console.log(
      '[e2e:crashpad-cleanup-v2]',
      JSON.stringify({
        version: 'linux-procfs-guard-receipt-v2',
        platform: process.platform,
        userDataDir,
        electronExecutable,
        events
      })
    )
  record('entered')
  // Windows cleanup uses the launcher's existing taskkill /T boundary.
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    record('unsupported-platform')
    receipt()
    return
  }
  const executable = canonicalPath(
    path.resolve(
      path.dirname(electronExecutable),
      process.platform === 'darwin'
        ? '../Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
        : 'chrome_crashpad_handler'
    )
  )
  const database = canonicalPath(path.join(userDataDir, 'Crashpad'))
  record('canonical-paths', { executable, database })
  if (!executable || !database) {
    record('missing-canonical-path')
    receipt()
    return
  }
  const matched: { pid: number; identity: ProcessIdentity }[] = []
  // Read executable names first; unrelated processes' arguments need not be inspected.
  const processes = readPs(['-ww', '-axo', 'pid=,comm='])
  for (const line of processes.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) {
      continue
    }
    const matchesExecutable =
      process.platform === 'linux'
        ? [path.basename(executable), path.basename(executable).slice(0, 15)].includes(match[2])
        : canonicalPath(match[2]) === executable
    if (!matchesExecutable) {
      continue
    }
    const pid = Number(match[1])
    if (pid <= 1 || pid === process.pid) {
      continue
    }
    const identity = readProcessIdentity(pid)
    const owned = identity !== undefined && ownsCrashpad(identity, executable, database)
    record('candidate', { pid, identityRead: identity !== undefined, owned })
    if (!identity || !owned) {
      continue
    }
    matched.push({ pid, identity })
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      // A PID may have been recycled since enumeration or the previous signal.
      const current = readProcessIdentity(pid)
      if (
        !current ||
        !sameProcess(identity, current) ||
        !ownsCrashpad(current, executable, database)
      ) {
        record('identity-changed-before-signal', { pid, signal })
        break
      }
      try {
        process.kill(pid, signal)
        record('signal-sent', { pid, signal })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          record('already-exited', { pid, signal })
          break
        }
        record('signal-error', { pid, signal, code: (error as NodeJS.ErrnoException).code })
        receipt()
        throw error
      }
      if (await waitForIdentityToExit(pid, identity)) {
        record('identity-exited', { pid, signal })
        break
      }
      if (signal === 'SIGKILL') {
        record('identity-retained', { pid })
        receipt()
        throw new Error(`Disposable profile Crashpad helper ${pid} did not exit`)
      }
    }
  }
  const retained = matched.filter(({ pid, identity }) =>
    sameProcess(identity, readProcessIdentity(pid))
  )
  record('postcondition', {
    matched: matched.map(({ pid }) => pid),
    retained: retained.map(({ pid }) => pid)
  })
  receipt()
  if (retained.length) {
    throw new Error('Disposable profile retains verified Crashpad process identities')
  }
}
