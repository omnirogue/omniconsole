/**
 * `<userData>/session-organization/outbox.json`: `t` sync entries this host produced (and entries
 * a Mac forwards for an SSH relay) that have not reached the account yet. The steward sync pass
 * publishes them in this computer's own `t` documents; an SSH relay has no account access, so a
 * connected Mac drains its outbox instead. Merged by entry id, the later entry winning.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mergeSessionHostSyncDocs,
  parseSessionHostSyncDoc,
  sessionHostSyncDocValue,
  sessionHostSyncEntryId,
  type SessionHostSyncDoc,
  type SessionHostSyncEntry
} from '../../shared/session-host-sync-doc'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'

export const HOST_ORGANIZATION_OUTBOX_FILE = 'outbox.json'
/** Past this, the oldest history rows go first; revocations and ownership never do. */
export const HOST_ORGANIZATION_OUTBOX_MAX = 20_000
const STALE_TEMP_AGE_MS = 60_000

/** One queued entry: `seq` orders delivery; a later update to the same id takes a new one. */
export type HostOrganizationOutboxItem = { id: string; seq: number; entry: unknown }

type OutboxFile = { version: 1; seq: number; items: HostOrganizationOutboxItem[] }

function asDoc(id: string, entry: unknown): SessionHostSyncDoc {
  const parsed = parseSessionHostSyncDoc({ v: 1, e: { [id]: entry } })
  return parsed.status === 'read' ? parsed.doc : { entries: {}, opaque: {} }
}

function only(doc: SessionHostSyncDoc): unknown {
  return Object.values(sessionHostSyncDocValue(doc).e)[0]
}

export class HostOrganizationOutbox {
  private readonly items = new Map<string, HostOrganizationOutboxItem>()
  private seq = 0
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: { directory: string; max?: number }) {}

  get path(): string {
    return join(this.options.directory, HOST_ORGANIZATION_OUTBOX_FILE)
  }

  get size(): number {
    return this.items.size
  }

  load(): void {
    let raw: Partial<OutboxFile>
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<OutboxFile>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[session-organization] ${this.path} is unreadable; starting empty`, error)
      }
      return
    }
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      if (typeof item?.id === 'string' && typeof item.seq === 'number' && item.entry) {
        this.items.set(item.id, item)
        this.seq = Math.max(this.seq, item.seq)
      }
    }
    this.seq = Math.max(this.seq, typeof raw.seq === 'number' ? raw.seq : 0)
    void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_TEMP_AGE_MS })
  }

  /** Hears every put that queued something new; returns the unsubscribe. */
  onQueued(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Queues entries this host wrote; an entry no newer than the queued one is ignored. */
  put(entries: readonly SessionHostSyncEntry[]): number {
    return this.putRaw(entries.map((entry) => ({ id: sessionHostSyncEntryId(entry), entry })))
  }

  /**
   * Queues entries as they arrived (a relay's outbox a Mac forwards): unknown kinds stay opaque,
   * and a known kind under the wrong id is dropped, as the sync document would drop it.
   */
  putRaw(entries: readonly { id: string; entry: unknown }[]): number {
    let queued = 0
    for (const { id, entry } of entries) {
      const incoming = asDoc(id, entry)
      if (!only(incoming)) {
        continue
      }
      const held = this.items.get(id)
      const merged = held ? mergeSessionHostSyncDocs(asDoc(id, held.entry), incoming) : incoming
      const value = only(merged)
      if (held && JSON.stringify(value) === JSON.stringify(held.entry)) {
        continue
      }
      this.items.set(id, { id, seq: ++this.seq, entry: value })
      queued += 1
    }
    if (queued > 0) {
      this.enforceCap()
      this.persist()
      for (const listener of this.listeners) {
        listener()
      }
    }
    return queued
  }

  /** Queued entries, oldest first. */
  pending(limit = Number.POSITIVE_INFINITY): HostOrganizationOutboxItem[] {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq).slice(0, limit)
  }

  /** Delivered: each item goes unless it was updated (a newer `seq`) since it was read. */
  ack(delivered: readonly Pick<HostOrganizationOutboxItem, 'id' | 'seq'>[]): void {
    let removed = 0
    for (const { id, seq } of delivered) {
      if (this.items.get(id)?.seq === seq) {
        this.items.delete(id)
        removed += 1
      }
    }
    if (removed > 0) {
      this.persist()
    }
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private enforceCap(): void {
    const max = this.options.max ?? HOST_ORGANIZATION_OUTBOX_MAX
    if (this.items.size <= max) {
      return
    }
    const history = this.pending().filter(
      (item) => (item.entry as { k?: unknown } | null)?.k === 'hist'
    )
    for (const item of history.slice(0, this.items.size - max)) {
      this.items.delete(item.id)
    }
  }

  private persist(): void {
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const file: OutboxFile = { version: 1, seq: this.seq, items: this.pending() }
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, JSON.stringify(file))
      })
      .catch((error: unknown) => {
        console.error(`[session-organization] saving ${finalPath} failed`, error)
      })
  }
}
