import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export type SessionAnswerQuarantine = {
  has(key: string): boolean
  add(key: string, evidence?: unknown): void
  delete(key: string): void
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** An exclusive marker survives main/daemon restarts; unreadable state never means no pending answer. */
export class PersistentSessionAnswerQuarantine implements SessionAnswerQuarantine {
  private readonly directory: string
  constructor(profileDirectory: string) {
    this.directory = join(profileDirectory, 'session-answer-pending-v1')
  }

  private path(key: string): string {
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  }

  has(key: string): boolean {
    try {
      lstatSync(this.path(key))
      return true
    } catch (error) {
      if (missing(error)) {
        return false
      }
      throw error
    }
  }

  add(key: string, evidence?: unknown): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const fd = openSync(this.path(key), 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, key, at: new Date().toISOString(), evidence }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  delete(key: string): void {
    try {
      unlinkSync(this.path(key))
    } catch (error) {
      if (!missing(error)) {
        throw error
      }
    }
  }
}
