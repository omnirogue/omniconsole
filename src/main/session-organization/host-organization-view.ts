/**
 * `<userData>/session-organization/host-values.json`: each session's organization values as this
 * host's ledger applied them (a fold of its applied records; see session-organization-host.ts),
 * plus values imported by migration, headless changes a window has not adopted yet, and each
 * key's account-sync digest. Derived: a lost file is rebuilt from history at the next start.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrganizationRecord } from '../../shared/session-organization-change'
import {
  foldHostOrganizationRecord,
  migratedRevision,
  type HostOrganizationEntry,
  type HostOrganizationField,
  type HostOrganizationValues
} from '../../shared/session-organization-host'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'

export const HOST_ORGANIZATION_VIEW_FILE = 'host-values.json'
/** Headless changes kept for a window to adopt; beyond this the oldest are dropped. */
export const HOST_ORGANIZATION_UNADOPTED_MAX = 1000
const ADOPTED_MEMORY = 2000
const STALE_TEMP_AGE_MS = 60_000
const DIGEST = /^[0-9a-f]{24}$/

type ViewFile = {
  version: 1
  appliedThrough: string | null
  /** Additive (session parity): through when `delete` records are folded; older builds drop it. */
  deletedThrough?: string | null
  migratedAt: string | null
  entries: Record<string, HostOrganizationEntry>
  unadopted: string[]
  adopted: string[]
}

function parseEntry(raw: unknown): HostOrganizationEntry | null {
  const entry = raw as Partial<HostOrganizationEntry> | null
  if (!entry || typeof entry !== 'object' || !entry.values || typeof entry.values !== 'object') {
    return null
  }
  const strings = (value: unknown): Record<string, string> =>
    value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            (pair): pair is [string, string] => typeof pair[1] === 'string'
          )
        )
      : {}
  return {
    values: entry.values,
    revisions: strings(entry.revisions),
    stamps: strings(entry.stamps),
    ...(typeof entry.revision === 'string' ? { revision: entry.revision } : {}),
    ...(typeof entry.at === 'string' ? { at: entry.at } : {}),
    ...(typeof entry.digest === 'string' && DIGEST.test(entry.digest)
      ? { digest: entry.digest }
      : {})
  }
}

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

export class HostOrganizationView {
  private readonly entries = new Map<string, HostOrganizationEntry>()
  private readonly byDigest = new Map<string, Set<string>>()
  private unadoptedIds: string[] = []
  private adoptedIds: string[] = []
  private appliedThroughValue: string | null = null
  private deletedThroughValue: string | null = null
  private deletesFolded = false
  private migratedAtValue: string | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false
  private persistError: string | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: { directory: string }) {}

  /**
   * Hears every change to the values once it is applied in memory (a fold, an import, a key move),
   * so the owner's conversation ledger and its tombstones follow (session parity, step 3).
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get path(): string {
    return join(this.options.directory, HOST_ORGANIZATION_VIEW_FILE)
  }

  /** The newest applied record folded; history newer than it is folded again at start. */
  get appliedThrough(): string | null {
    return this.appliedThroughValue
  }

  /**
   * Through when `delete` records are folded (host-organization-delete-catch-up.ts): null in a
   * file an older build wrote, which moved `appliedThrough` past deletes it never folded.
   */
  get deletedThrough(): string | null {
    return this.deletesFolded ? this.appliedThroughValue : this.deletedThroughValue
  }

  /** Start folded every retained delete: from here on the watermark follows `appliedThrough`. */
  markDeletesFolded(): void {
    const before = this.deletedThrough
    this.deletesFolded = true
    if (before !== this.deletedThrough) {
      this.persist()
    }
  }

  /** When existing values and provenance were imported; automation waits for it. */
  get migratedAt(): string | null {
    return this.migratedAtValue
  }

  get storageError(): string | undefined {
    return this.persistError
  }

  /** Reads the saved values once; an unreadable file starts empty and history refills it. */
  load(): void {
    let raw: Partial<ViewFile>
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ViewFile>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[session-organization] ${this.path} is unreadable; rebuilding it`, error)
      }
      return
    }
    for (const [key, value] of Object.entries(raw.entries ?? {})) {
      const entry = parseEntry(value)
      if (entry) {
        this.put(key, entry)
      }
    }
    this.unadoptedIds = idList(raw.unadopted)
    this.adoptedIds = idList(raw.adopted)
    this.appliedThroughValue = typeof raw.appliedThrough === 'string' ? raw.appliedThrough : null
    this.deletedThroughValue = typeof raw.deletedThrough === 'string' ? raw.deletedThrough : null
    this.migratedAtValue = typeof raw.migratedAt === 'string' ? raw.migratedAt : null
    void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_TEMP_AGE_MS })
  }

  entry(key: string): HostOrganizationEntry | undefined {
    return this.entries.get(key)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  keysForDigest(digest: string): string[] {
    return [...(this.byDigest.get(digest) ?? [])]
  }

  /** One applied record into the values of the keys it touched; the keys that changed. */
  fold(record: OrganizationRecord): string[] {
    const next = foldHostOrganizationRecord(record, (key) => this.entries.get(key))
    for (const [key, entry] of next) {
      this.put(key, entry)
    }
    const fresh = this.appliedThroughValue === null || record.ts >= this.appliedThroughValue
    if (fresh) {
      this.appliedThroughValue = record.ts
    }
    const noted =
      record.headless === true &&
      next.size > 0 &&
      !this.unadoptedIds.includes(record.opId) &&
      !this.adoptedIds.includes(record.opId)
    if (noted) {
      this.unadoptedIds = [...this.unadoptedIds, record.opId].slice(
        -HOST_ORGANIZATION_UNADOPTED_MAX
      )
    }
    if (next.size > 0 || fresh || noted) {
      this.persist()
    }
    return [...next.keys()]
  }

  setDigest(key: string, digest: string): void {
    if (!DIGEST.test(digest) || this.entries.get(key)?.digest === digest) {
      return
    }
    this.put(key, { values: {}, revisions: {}, ...this.entries.get(key), digest })
    this.persist()
  }

  /** A value found before this host recorded any change to that field (migration). */
  importValue(
    key: string,
    field: HostOrganizationField,
    values: Partial<HostOrganizationValues>,
    at: string
  ): void {
    const entry = this.entries.get(key) ?? { values: {}, revisions: {} }
    const revision = migratedRevision(at)
    this.put(key, {
      ...entry,
      values: { ...entry.values, ...values },
      revisions: { ...entry.revisions, [field]: revision },
      stamps: { ...entry.stamps, [field]: at },
      ...(!entry.at || at >= entry.at ? { revision, at } : {})
    })
    this.persist()
  }

  markMigrated(at: string): void {
    if (this.migratedAtValue === null) {
      this.migratedAtValue = at
      this.persist()
    }
  }

  /** Headless changes a window has not adopted yet, oldest first. */
  unadopted(): string[] {
    return [...this.unadoptedIds]
  }

  /** A window adopted these (or found them superseded); they are never handed out again. */
  settleAdopted(opIds: readonly string[]): void {
    const done = new Set(opIds)
    const before = this.unadoptedIds.length
    this.unadoptedIds = this.unadoptedIds.filter((id) => !done.has(id))
    this.adoptedIds = [
      ...this.adoptedIds,
      ...opIds.filter((id) => !this.adoptedIds.includes(id))
    ].slice(-ADOPTED_MEMORY)
    if (this.unadoptedIds.length !== before || opIds.length > 0) {
      this.persist()
    }
  }

  /** A pane's values follow its provider key; the provider key's own values win field by field. */
  migrateKey(from: string, to: string): boolean {
    const moved = this.entries.get(from)
    if (from === to || !moved) {
      return false
    }
    const kept = this.entries.get(to)
    this.drop(from)
    this.put(
      to,
      kept
        ? {
            ...moved,
            ...kept,
            values: { ...moved.values, ...kept.values },
            revisions: { ...moved.revisions, ...kept.revisions },
            stamps: { ...moved.stamps, ...kept.stamps }
          }
        : moved
    )
    this.persist()
    return true
  }

  /** Settles every write already started; for quit and tests. */
  async flush(): Promise<void> {
    await this.writeChain
  }

  private put(key: string, entry: HostOrganizationEntry): void {
    const old = this.entries.get(key)?.digest
    if (old && old !== entry.digest) {
      this.byDigest.get(old)?.delete(key)
    }
    this.entries.set(key, entry)
    if (entry.digest) {
      this.byDigest.set(entry.digest, (this.byDigest.get(entry.digest) ?? new Set()).add(key))
    }
  }

  private drop(key: string): void {
    const digest = this.entries.get(key)?.digest
    if (digest) {
      this.byDigest.get(digest)?.delete(key)
    }
    this.entries.delete(key)
  }

  private persist(): void {
    // Why here: every change persists, so every change is heard, before the coalesced write.
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[session-organization] a host values listener failed', error)
      }
    }
    // Coalesced: a burst of changes writes the newest state once.
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const file: ViewFile = {
          version: 1,
          appliedThrough: this.appliedThroughValue,
          deletedThrough: this.deletedThrough,
          migratedAt: this.migratedAtValue,
          entries: Object.fromEntries(this.entries),
          unadopted: this.unadoptedIds,
          adopted: this.adoptedIds
        }
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, JSON.stringify(file))
      })
      .then(
        () => {
          this.persistError = undefined
        },
        (error: unknown) => {
          this.persistError = `Session organization values could not be saved: ${error instanceof Error ? error.message : String(error)}`
          console.error(`[session-organization] saving ${finalPath} failed`, error)
        }
      )
  }
}
