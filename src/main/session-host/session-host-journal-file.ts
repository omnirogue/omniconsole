/**
 * The registry's files and its exclusive writer lock. Every transaction runs serially in this
 * process and under a cross-process lock, reads the journal fresh, and publishes it with an fsync'd
 * rename before the lock is released, so two processes on one account never interleave a decision.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { isSessionHostId, sessionHostId } from '../../shared/session-host-identity'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import {
  emptySessionHostJournal,
  parseSessionHostJournal,
  type SessionHostJournal,
  type SessionHostJournalRead
} from './session-host-journal'

const REGISTRY_FILE = 'registry.json'
const JOURNAL_FILE = 'journal.json'
const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = { retries: 30, factor: 1.3, minTimeout: 10, maxTimeout: 250, randomize: true }

/** Storage failed or is contended: nothing was decided and nothing was changed. */
export class SessionHostStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionHostStorageError'
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw new SessionHostStorageError(
      `The session host registry cannot be read (${String(error)}).`
    )
  }
}

export class SessionHostJournalFile {
  readonly registryPath: string
  readonly journalPath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly root: string) {
    this.registryPath = join(root, REGISTRY_FILE)
    this.journalPath = join(root, JOURNAL_FILE)
  }

  /** The host id this account's registry minted; null before the first open created it. */
  readHostId(): string | null {
    const text = readText(this.registryPath)
    if (text === null) {
      return null
    }
    try {
      const hostId = (JSON.parse(text) as { hostId?: unknown }).hostId
      if (isSessionHostId(hostId)) {
        return hostId
      }
    } catch {
      // Falls through to the refusal below.
    }
    throw new SessionHostStorageError('The session host registry file is unreadable.')
  }

  /** Mints the host id once, under the writer lock; every later opener reads the same one. */
  async readOrMintHostId(): Promise<string> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    return await this.transact(() => {
      const existing = this.readHostId()
      if (existing) {
        return existing
      }
      const hostId = sessionHostId(randomUUID())
      const registry = JSON.stringify({ v: 1, hostId, createdAt: Date.now() })
      writeFileDurableSync(durableWriteTempPath(this.registryPath), this.registryPath, registry)
      if (readText(this.journalPath) === null) {
        this.write(emptySessionHostJournal(hostId))
      }
      return hostId
    })
  }

  read(hostId: string): SessionHostJournalRead {
    const text = readText(this.journalPath)
    return text === null
      ? { ok: true, journal: emptySessionHostJournal(hostId), writable: true }
      : parseSessionHostJournal(text, hostId)
  }

  write(journal: SessionHostJournal): void {
    try {
      writeFileDurableSync(
        durableWriteTempPath(this.journalPath),
        this.journalPath,
        JSON.stringify(journal)
      )
    } catch (error) {
      throw new SessionHostStorageError(
        `The session host journal cannot be written (${String(error)}).`
      )
    }
  }

  /** Serialized in this process first, so one process never contends with itself for the lock. */
  transact<T>(apply: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(() => this.locked(apply))
    this.queue = run.catch(() => {})
    return run
  }

  private async locked<T>(apply: () => Promise<T> | T): Promise<T> {
    let release: () => Promise<void>
    try {
      release = await lock(this.journalPath, {
        realpath: false,
        stale: LOCK_STALE_MS,
        retries: LOCK_RETRIES,
        // Why not the default (throw): that throw lands in a timer and would crash a relay daemon.
        onCompromised: () => {}
      })
    } catch (error) {
      throw new SessionHostStorageError(
        `Another OmniConsole process is holding this computer's session records (${String(error)}).`
      )
    }
    try {
      return await apply()
    } finally {
      await release().catch(() => {})
    }
  }
}
