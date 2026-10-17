/**
 * `<userData>/session-organization/history.json`: per session (or folder) key the last 50 applied
 * organization changes, plus ownership receipts and permanent revocations. Authoritative for
 * history and Undo; `session-actions.jsonl` is the append-only trail it is rebuilt from.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  organizationTargetKey,
  revisionFieldOf,
  type OrganizationChangeKind,
  type OrganizationExecutorKind,
  type OrganizationKeyState,
  type OrganizationRecord
} from '../../shared/session-organization-change'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'
import { OrganizationKeyStates } from './organization-key-states'

export const ORGANIZATION_HISTORY_DIRECTORY = 'session-organization'
export const ORGANIZATION_HISTORY_FILE = 'history.json'
export const ORGANIZATION_HISTORY_PER_KEY = 50
export const ORGANIZATION_HISTORY_MAX_BYTES = 5 * 1024 * 1024
const STALE_TEMP_AGE_MS = 60_000
// Why: a key's share of one index entry in the file (quotes, comma), counted with the records.
const INDEX_ENTRY_OVERHEAD_BYTES = 4

type HistoryFile = {
  version: 1
  /** The newest applied ts ever added; trail lines older than it were seen (or pruned) already. */
  appliedThrough: string | null
  records: OrganizationRecord[]
  index: Record<string, string[]>
  keys: Record<string, OrganizationKeyState>
}

export type OrganizationRecentFilter = {
  since: number
  executors?: readonly OrganizationExecutorKind[]
  kinds?: readonly OrganizationChangeKind[]
  limit: number
}

export type OrganizationHistoryStoreOptions = {
  /** `<userData>/session-organization`. */
  directory: string
  maxBytes?: number
  perKey?: number
}

function targetKeys(record: OrganizationRecord): string[] {
  const keys = record.targets.map(organizationTargetKey)
  return [...new Set(keys.filter((key): key is string => key !== null))]
}

/** Only applied records with the shape every reader relies on; per-target arrays stay aligned. */
function parseRecord(raw: unknown): OrganizationRecord | null {
  const record = raw as Partial<OrganizationRecord> | null
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.opId !== 'string' ||
    record.phase !== 'applied' ||
    typeof record.ts !== 'string' ||
    typeof record.kind !== 'string' ||
    !Array.isArray(record.targets) ||
    typeof record.executor?.kind !== 'string'
  ) {
    return null
  }
  const aligned = (values: unknown): boolean =>
    Array.isArray(values) && values.length === record.targets!.length
  const { before, after, ...rest } = record as OrganizationRecord
  return {
    ...rest,
    ...(aligned(before) ? { before } : {}),
    ...(aligned(after) ? { after } : {})
  }
}

export class OrganizationHistoryStore {
  /** Insertion order is oldest first; the size cap prunes from the front. */
  private records = new Map<string, OrganizationRecord>()
  private recordBytes = new Map<string, number>()
  private index = new Map<string, string[]>()
  private readonly keyStates = new OrganizationKeyStates()
  private appliedThroughValue: string | null = null
  private bytes = 0
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false
  private persistError: string | undefined

  constructor(private readonly options: OrganizationHistoryStoreOptions) {}

  get path(): string {
    return join(this.options.directory, ORGANIZATION_HISTORY_FILE)
  }

  get appliedThrough(): string | null {
    return this.appliedThroughValue
  }

  /** The last failure to save, until a later save succeeds. */
  get storageError(): string | undefined {
    return this.persistError
  }

  /** Reads the saved history once; an unreadable file starts empty and the trail refills it. */
  load(): void {
    let raw: Partial<HistoryFile>
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<HistoryFile>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[session-organization] ${this.path} is unreadable; rebuilding it`, error)
      }
      return
    }
    const records = Array.isArray(raw.records) ? raw.records : []
    for (const record of records.map(parseRecord)) {
      if (record && !this.records.has(record.opId)) {
        this.insert(record)
      }
    }
    for (const [key, opIds] of Object.entries(raw.index ?? {})) {
      const kept = Array.isArray(opIds) ? opIds.filter((opId) => this.records.has(opId)) : []
      if (kept.length > 0) {
        this.index.set(key, kept)
        for (const opId of kept) {
          this.bytes += key.length + opId.length + INDEX_ENTRY_OVERHEAD_BYTES
        }
      }
    }
    this.keyStates.load(raw.keys)
    this.appliedThroughValue = typeof raw.appliedThrough === 'string' ? raw.appliedThrough : null
    void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_TEMP_AGE_MS })
  }

  has(opId: string): boolean {
    return this.records.has(opId)
  }

  get(opId: string): OrganizationRecord | undefined {
    return this.records.get(opId)
  }

  /** Adds one applied record (idempotent by opId), with its ownership or revocation. */
  add(record: OrganizationRecord): void {
    if (record.phase !== 'applied' || this.records.has(record.opId)) {
      return
    }
    this.insert(record)
    const perKey = this.options.perKey ?? ORGANIZATION_HISTORY_PER_KEY
    for (const key of targetKeys(record)) {
      const opIds = [...(this.index.get(key) ?? []), record.opId]
      this.index.set(key, opIds.slice(-perKey))
      this.bytes += key.length + record.opId.length + INDEX_ENTRY_OVERHEAD_BYTES
      for (const dropped of opIds.slice(0, -perKey)) {
        this.forget(key, dropped)
      }
    }
    this.keyStates.applyRecord(record)
    if (this.appliedThroughValue === null || record.ts > this.appliedThroughValue) {
      this.appliedThroughValue = record.ts
    }
    this.enforceCap()
    this.persist()
  }

  /** A key's applied changes, newest first. */
  entriesFor(key: string): OrganizationRecord[] {
    return (this.index.get(key) ?? [])
      .toReversed()
      .map((opId) => this.records.get(opId))
      .filter((record): record is OrganizationRecord => record !== undefined)
  }

  /** The newest applied change to one field of a key: its revision is the key's current one. */
  latestFor(key: string, field: string): OrganizationRecord | undefined {
    return this.entriesFor(key).find((record) => revisionFieldOf(record.kind) === field)
  }

  stateFor(key: string): OrganizationKeyState {
    return this.keyStates.stateFor(key)
  }

  /** Ownership and revocations to read; change them through `updateOwnership`. */
  get ownership(): Pick<OrganizationKeyStates, 'stateFor' | 'snapshot'> {
    return this.keyStates
  }

  /** Runs an ownership change (sync stamps, seeding) and saves when it changed anything. */
  updateOwnership(change: (states: OrganizationKeyStates) => string[]): string[] {
    const changed = change(this.keyStates)
    if (changed.length > 0) {
      this.persist()
    }
    return changed
  }

  /**
   * A pane's history and ownership folded onto its provider key: its records now name `to`, so
   * history and Undo follow the session; the per-key cap still holds. False when nothing moved.
   */
  migrateKey(from: string, to: string, placementFrom: boolean): boolean {
    const moved = from === to ? [] : (this.index.get(from) ?? [])
    const carried = this.keyStates.migrate(from, to, placementFrom)
    if (moved.length === 0) {
      if (carried) {
        this.persist()
      }
      return carried
    }
    for (const opId of moved) {
      const record = this.records.get(opId)
      this.bytes -= from.length + opId.length + INDEX_ENTRY_OVERHEAD_BYTES
      if (record) {
        this.bytes -= this.recordBytes.get(opId) ?? 0
        this.insert({
          ...record,
          targets: record.targets.map((target) =>
            target.sessionKey === from ? { ...target, sessionKey: to } : target
          )
        })
      }
    }
    this.index.delete(from)
    const kept = this.index.get(to) ?? []
    const added = moved.filter((opId) => !kept.includes(opId))
    for (const opId of added) {
      this.bytes += to.length + opId.length + INDEX_ENTRY_OVERHEAD_BYTES
    }
    const ts = (opId: string) => this.records.get(opId)?.ts ?? ''
    const merged = [...kept, ...added].sort((left, right) => ts(left).localeCompare(ts(right)))
    const perKey = this.options.perKey ?? ORGANIZATION_HISTORY_PER_KEY
    this.index.set(to, merged.slice(-perKey))
    for (const dropped of merged.slice(0, -perKey)) {
      this.forget(to, dropped)
    }
    this.persist()
    return true
  }

  recent(filter: OrganizationRecentFilter): OrganizationRecord[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          Date.parse(record.ts) >= filter.since &&
          (!filter.executors || filter.executors.includes(record.executor.kind)) &&
          (!filter.kinds || filter.kinds.includes(record.kind))
      )
      .toReversed()
      .slice(0, filter.limit)
  }

  /** Settles every write already started; for quit and tests. */
  async flush(): Promise<void> {
    await this.writeChain
  }

  private insert(record: OrganizationRecord): void {
    const size = Buffer.byteLength(JSON.stringify(record))
    this.records.set(record.opId, record)
    this.recordBytes.set(record.opId, size)
    this.bytes += size
  }

  /** Drops `opId` from `key`'s rolling list, and the record once no key lists it. */
  private forget(key: string, opId: string): void {
    this.bytes -= key.length + opId.length + INDEX_ENTRY_OVERHEAD_BYTES
    const record = this.records.get(opId)
    const listed = record
      ? targetKeys(record).some((other) => other !== key && this.index.get(other)?.includes(opId))
      : false
    if (!listed) {
      this.bytes -= this.recordBytes.get(opId) ?? 0
      this.records.delete(opId)
      this.recordBytes.delete(opId)
    }
  }

  /** Past the cap, the oldest rolling entries go first; ownership and revocations never do. */
  private enforceCap(): void {
    const maxBytes = this.options.maxBytes ?? ORGANIZATION_HISTORY_MAX_BYTES
    for (const [opId, record] of this.records) {
      if (this.bytes <= maxBytes) {
        return
      }
      for (const key of targetKeys(record)) {
        const opIds = this.index.get(key)
        if (opIds?.includes(opId)) {
          const kept = opIds.filter((listed) => listed !== opId)
          if (kept.length > 0) {
            this.index.set(key, kept)
          } else {
            this.index.delete(key)
          }
          this.bytes -= key.length + opId.length + INDEX_ENTRY_OVERHEAD_BYTES
        }
      }
      this.bytes -= this.recordBytes.get(opId) ?? 0
      this.records.delete(opId)
      this.recordBytes.delete(opId)
    }
  }

  private persist(): void {
    // Coalesced: a burst of changes writes the newest state once.
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const file: HistoryFile = {
          version: 1,
          appliedThrough: this.appliedThroughValue,
          records: [...this.records.values()],
          index: Object.fromEntries(this.index),
          keys: this.keyStates.toJSON()
        }
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, JSON.stringify(file))
      })
      .then(
        () => {
          this.persistError = undefined
        },
        (error: unknown) => {
          this.persistError = `Session history could not be saved: ${error instanceof Error ? error.message : String(error)}`
          console.error(`[session-organization] saving ${finalPath} failed`, error)
        }
      )
  }
}
