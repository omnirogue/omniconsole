/**
 * A short claim on `intents/<key>.claim` so two identical `omni session launch` invocations never
 * plan at once. See docs/reference/agent-launch.md.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { RuntimeClientError } from './runtime/types'
import { LAUNCH_INTENTS_DIR_NAME, type AgentLaunchRecordStore } from './session-launch-record'
import { readLaunchClaimProcessBirth } from './session-launch-process-birth'

export type LaunchClaimOptions = {
  waitMs?: number
  pollMs?: number
  /** Active claims refresh at a fraction of this interval; age never proves a live owner dead. */
  staleMs?: number
  isAlive?: (pid: number) => boolean
  readBirth?: (pid: number) => Promise<number | null>
}

type ClaimHolder = { pid: number; at: number; token?: string; birth?: number }

// Why: a birth recheck can take seconds; only an old lock can be reclaimed by age.
const STEAL_LOCK_STALE_MS = 15_000

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function readClaimHolder(path: string): ClaimHolder | null {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as Partial<ClaimHolder>
    if (typeof holder.pid === 'number' && typeof holder.at === 'number') {
      return {
        pid: holder.pid,
        at: holder.at,
        ...(typeof holder.token === 'string' ? { token: holder.token } : {}),
        ...(typeof holder.birth === 'number' ? { birth: holder.birth } : {})
      }
    }
  } catch {
    // Fall through: a claim caught between create and write has no holder yet.
  }
  try {
    return { pid: -1, at: statSync(path).mtimeMs }
  } catch {
    return null
  }
}

function tryCreateClaim(path: string, holder: ClaimHolder): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(holder))
  } finally {
    closeSync(fd)
  }
  return true
}

function isAbandoned(
  holder: ClaimHolder,
  isAlive: (pid: number) => boolean,
  staleMs: number,
  readBirth: (pid: number) => Promise<number | null>
): Promise<boolean> {
  if (holder.pid <= 0) {
    return Promise.resolve(Date.now() - holder.at > staleMs)
  }
  if (!isAlive(holder.pid)) {
    return Promise.resolve(true)
  }
  if (holder.birth === undefined || Date.now() - holder.at <= staleMs) {
    return Promise.resolve(false)
  }
  return readBirth(holder.pid)
    .then((birth) => birth !== null && Math.abs(birth - holder.birth!) > 2_000)
    .catch(() => false)
}

function sameHolder(left: ClaimHolder | null, right: ClaimHolder): boolean {
  return (
    left?.pid === right.pid &&
    left.at === right.at &&
    left.token === right.token &&
    left.birth === right.birth
  )
}

function refreshClaim(path: string, mine: ClaimHolder): void {
  if (!sameHolder(readClaimHolder(path), mine)) {
    return
  }
  const next = { ...mine, at: Date.now() }
  const temporary = `${path}.${mine.token}.heartbeat`
  try {
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
    if (sameHolder(readClaimHolder(path), mine)) {
      renameSync(temporary, path)
      mine.at = next.at
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Removes the claim only while it still names `seen`. The exclusive steal lock makes that check
 * and the removal one step, so a waiter never deletes the fresh claim another waiter just made.
 * False when another waiter is mid-steal.
 */
async function stealClaim(
  path: string,
  seen: ClaimHolder,
  isAlive: (pid: number) => boolean,
  staleMs: number,
  readBirth: (pid: number) => Promise<number | null>
): Promise<boolean> {
  const lock = `${path}.steal`
  if (!tryCreateClaim(lock, { pid: process.pid, at: Date.now() })) {
    const holder = readClaimHolder(lock)
    if (
      holder &&
      ((!isAlive(holder.pid) && holder.pid > 0) || Date.now() - holder.at > STEAL_LOCK_STALE_MS)
    ) {
      rmSync(lock, { force: true })
    }
    return false
  }
  try {
    const current = readClaimHolder(path)
    if (
      sameHolder(current, seen) &&
      current &&
      (await isAbandoned(current, isAlive, staleMs, readBirth)) &&
      sameHolder(readClaimHolder(path), current)
    ) {
      rmSync(path, { force: true })
    }
  } finally {
    rmSync(lock, { force: true })
  }
  return true
}

/**
 * Holds `intents/<key>.claim` while `fn` plans. A second identical invocation polls; a dead
 * holder's claim is stolen at once. A live process keeps its claim, even past `staleMs`.
 */
export async function withLaunchClaim<T>(
  store: AgentLaunchRecordStore,
  intentKey: string,
  fn: () => Promise<T>,
  options: LaunchClaimOptions = {}
): Promise<T> {
  const {
    waitMs = 30_000,
    pollMs = 200,
    staleMs = 120_000,
    isAlive = processIsAlive,
    readBirth = readLaunchClaimProcessBirth
  } = options
  const path = join(store.dir, LAUNCH_INTENTS_DIR_NAME, `${intentKey}.claim`)
  mkdirSync(join(store.dir, LAUNCH_INTENTS_DIR_NAME), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  const observedBirth = await readBirth(process.pid).catch(() => null)
  const mine: ClaimHolder = {
    pid: process.pid,
    at: Date.now(),
    token: randomUUID(),
    ...(observedBirth !== null ? { birth: observedBirth } : {})
  }
  while (!tryCreateClaim(path, mine)) {
    const holder = readClaimHolder(path)
    if (holder === null) {
      continue
    }
    if (
      (await isAbandoned(holder, isAlive, staleMs, readBirth)) &&
      (await stealClaim(path, holder, isAlive, staleMs, readBirth))
    ) {
      continue
    }
    if (Date.now() >= deadline) {
      throw new RuntimeClientError(
        'launch_busy',
        'An identical omni session launch on this computer is still being planned. Wait for it to finish, then run this same command again. Nothing was sent.',
        { outcome: 'not-sent', nextSteps: ['Run this same command again in a few seconds.'] }
      )
    }
    await new Promise((done) => setTimeout(done, pollMs))
    mine.at = Date.now()
  }
  const heartbeat = setInterval(
    () => {
      try {
        refreshClaim(path, mine)
      } catch {
        // A failed heartbeat cannot grant another process ownership of this live claim.
      }
    },
    Math.max(100, Math.floor(staleMs / 3))
  )
  heartbeat.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    const current = readClaimHolder(path)
    if (sameHolder(current, mine)) {
      rmSync(path, { force: true })
    }
  }
}
