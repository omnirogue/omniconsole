import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STEWARD_DIRECTORY } from './steward-state-store'

/**
 * When this computer last had each SSH host connected: stamped when a relay connection is made,
 * kept across restarts once the steward names its file. The third blank rule counts a host's day
 * of unreachability from here, and a grant carries the stamp it was made on, so a reconnect the
 * window's clock missed, or one during the settle recheck, voids it.
 */
const FILE = 'ssh-last-reached.json'

let path: string | null = null
const reached = new Map<string, number>()

function readFile(file: string): Map<string, number> {
  const stored = new Map<string, number>()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const [targetId, at] of Object.entries(raw)) {
      if (typeof at === 'number' && Number.isFinite(at)) {
        stored.set(targetId, at)
      }
    }
  } catch {
    // A missing or damaged file knows no host; the window's own clock still bounds the day.
  }
  return stored
}

function write(): void {
  if (!path) {
    return
  }
  const temp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(temp, JSON.stringify(Object.fromEntries(reached)), { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    console.warn('[session-steward] could not record an SSH host as reached', error)
  }
}

/**
 * Called by the steward's start. Stamps made before it (a relay that connected first) are kept
 * and merged with the file; `null` forgets everything (tests, teardown).
 */
export function configureSshReachabilityLog(userDataPath: string | null): void {
  if (!userDataPath) {
    path = null
    reached.clear()
    return
  }
  path = join(userDataPath, STEWARD_DIRECTORY, FILE)
  for (const [targetId, at] of readFile(path)) {
    reached.set(targetId, Math.max(reached.get(targetId) ?? 0, at))
  }
  write()
}

export function noteSshTargetReached(targetId: string, now = Date.now()): void {
  reached.set(targetId, Math.max(reached.get(targetId) ?? 0, now))
  write()
}

/** Null when this computer has no record of ever having it connected. */
export function sshTargetLastReachedAt(targetId: string): number | null {
  return reached.get(targetId) ?? null
}
