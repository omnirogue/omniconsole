import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  readSessionConversationLedgerPublication,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval,
  type SessionConversationLedgerSource,
  type SessionConversationLedgerWindowPublication
} from '../../shared/session-conversation-ledger'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'
import { SessionConversationLedgerRemovals } from './session-conversation-ledger-store-removals'

/** Step 3's main-authored set: the body of a window publication without its renderer generation. */
export type SessionConversationLedgerMainSet = Omit<
  SessionConversationLedgerWindowPublication,
  'rendererGeneration'
>

// Why coalesced: a burst of window publications costs one durable write and never blocks a publish.
const OWNER_LEDGER_PERSIST_DELAY_MS = 1000
// Why an age: another live instance's write in flight is spared (HostOrganizationView does too).
const STALE_TEMP_AGE_MS = 60_000

type OwnerLedgerFile = { v: 1; publication: SessionConversationLedgerWindowPublication }
type LedgerView = {
  source: SessionConversationLedgerSource
  body: SessionConversationLedgerMainSet
}

const EMPTY_BODY: SessionConversationLedgerMainSet = {
  listedAt: 0,
  coverage: [],
  omitted: { unknownHost: 0, unverified: 0 },
  folders: [],
  projects: [],
  recordsByWorktree: {}
}

/** The last window publication this profile kept, read leniently: missing or corrupt is null. */
function readOwnerLedger(path: string | null): SessionConversationLedgerWindowPublication | null {
  if (!path) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerLedgerFile> | null
    return parsed?.v === 1 ? readSessionConversationLedgerPublication(parsed.publication) : null
  } catch {
    return null
  }
}

/** The fields a set shows, picked by name (never a renderer generation), empty buckets dropped. */
function toBody(set: SessionConversationLedgerMainSet): SessionConversationLedgerMainSet {
  return {
    listedAt: set.listedAt,
    coverage: set.coverage,
    omitted: set.omitted,
    ...(set.truncatedWorktrees?.length ? { truncatedWorktrees: set.truncatedWorktrees } : {}),
    folders: set.folders,
    projects: set.projects,
    recordsByWorktree: Object.fromEntries(
      Object.entries(set.recordsByWorktree).filter(([, records]) => records.length > 0)
    )
  }
}

/** Why the listing time is set aside: a republication of the same content is no change. */
function sameBody(a: SessionConversationLedgerMainSet, b: SessionConversationLedgerMainSet) {
  return isDeepStrictEqual({ ...a, listedAt: 0 }, { ...b, listedAt: 0 })
}

/**
 * This runtime's own conversation ledger (session parity, step 2): while its window is current, the
 * window's publication (`source: 'window'`); otherwise step 3's main-authored set, never one older
 * than the window's last listing, else that listing with every workspace incomplete (`source:
 * 'main'`, which removes nothing) — with
 * the deletion tombstones step 3 provides either way, from this incarnation's first set on and less
 * any a record of the same set lists (session-conversation-ledger-store-removals.ts). One
 * generation per runtime incarnation and one revision that moves on every visible change (records,
 * coverage, omissions, folders, projects, source, removals), so a receiver orders sets and deltas
 * and a late copy never restores what a
 * newer one removed. Each accepted window publication is also kept in `owner-ledger.json` (F17),
 * so a cold headless start still has the owner's catalog and titles.
 */
export class SessionConversationLedgerStore {
  readonly generation = randomUUID()
  private revision = 0
  private rendererGeneration: string | null = null
  private ownerPublishers = 0
  private windowCurrent = false
  private window: SessionConversationLedgerWindowPublication | null = null
  private main: SessionConversationLedgerMainSet | null = null
  private view: LedgerView
  private readonly removals = new SessionConversationLedgerRemovals()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly ownerLedgerPath: string | null
  private readonly loaded: SessionConversationLedgerWindowPublication | null
  private pendingWrite: SessionConversationLedgerWindowPublication | null = null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private writtenJson: string | null = null

  /**
   * `ownerLedgerPath`: `<userData>/session-host/owner-ledger.json`; null keeps nothing on disk.
   * `now`: the clock a tombstone shown again is stamped and retained by.
   */
  constructor(opts: { ownerLedgerPath: string | null; now?: () => number }) {
    this.now = opts.now ?? Date.now
    this.ownerLedgerPath = opts.ownerLedgerPath
    this.loaded = readOwnerLedger(opts.ownerLedgerPath)
    this.view = this.fallbackView()
    if (opts.ownerLedgerPath) {
      // Why: an exit between a durable write's temp file and its rename leaves the temp behind.
      void removeStaleDurableWriteTempFiles(opts.ownerLedgerPath, {
        minimumAgeMs: STALE_TEMP_AGE_MS
      })
    }
  }

  /**
   * Replaces the window set with the window's publication; true when anything visible changed. Why
   * the kept main set goes: it is older than this listing, and a main set's omissions remove
   * nothing, so showing it when the window goes would bring back what the window has since dropped.
   */
  publishWindow(publication: SessionConversationLedgerWindowPublication): boolean {
    this.rendererGeneration = publication.rendererGeneration
    this.main = null
    const body = toBody(publication)
    if (this.windowCurrent && sameBody(this.view.body, body)) {
      return false
    }
    this.window = publication
    this.windowCurrent = true
    this.show({ source: 'window', body }, true)
    this.scheduleWrite(publication)
    return true
  }

  /**
   * Step 3's set. Shown at once when no window is current; while one is (step 3 builds none then),
   * it is kept for the fallback, being newer than that window's last listing, and nothing visible
   * changes (false). The window's next publication drops it.
   */
  publishMain(set: SessionConversationLedgerMainSet): boolean {
    const body = toBody(set)
    if (this.main && sameBody(this.main, body)) {
      return false
    }
    this.main = body
    return this.windowCurrent ? false : this.show({ source: 'main', body }, true)
  }

  /**
   * The publishing window went away (closed, reload failed, or authority went back to the headless
   * graph): a main set kept since its last publication if there is one, else that last listing
   * with every workspace incomplete — never an older main set — until step 3's rebuild arrives.
   */
  markPublisherGone(): void {
    this.rendererGeneration = null
    if (this.windowCurrent) {
      this.windowCurrent = false
      this.show(this.fallbackView())
    }
  }

  /**
   * Step 3's retained tombstones. Each removal (identity, workspace and time) is stamped with the
   * revision at which a snapshot first shows it, so `removalsSince` serves a delta; none shows
   * before this incarnation's first published set, and one a listed record names is held back
   * until that record goes, then shows with that moment as its time. `aged`: deletions past
   * retention, shown only that way. True when what a snapshot shows changed.
   */
  setRemovals(
    removals: RuntimeSessionConversationRemoval[],
    truncated: boolean,
    aged: readonly RuntimeSessionConversationRemoval[] = []
  ): boolean {
    const records = this.view.body.recordsByWorktree
    if (!this.removals.set(removals, truncated, records, this.revision + 1, this.now(), aged)) {
      return false
    }
    this.changed()
    return true
  }

  /** The value a negotiated client receives: the whole set at the current revision. */
  snapshot(): RuntimeSessionConversationLedger {
    return {
      generation: this.generation,
      revision: this.revision,
      source: this.view.source,
      ...this.view.body,
      removals: this.removals.shown(),
      ...(this.removals.isTruncated() ? { removalsTruncated: true as const } : {})
    }
  }

  /**
   * Every removal snapshots show that they did not show at `revision` (a delta's removals against
   * its base): first published since, or shown again since its listed record went.
   */
  removalsSince(revision: number): RuntimeSessionConversationRemoval[] {
    return this.removals.shownSince(revision)
  }

  /** This incarnation's last window publication, else the one `owner-ledger.json` held (F17). */
  lastWindowPublication(): SessionConversationLedgerWindowPublication | null {
    return this.window ?? this.loaded
  }

  isWindowCurrent(): boolean {
    return this.windowCurrent
  }

  getRendererGeneration(): string | null {
    return this.rendererGeneration
  }

  /** Whether an owner publisher (startOwnerConversationLedger) runs: only then is it advertised. */
  hasOwnerPublisher(): boolean {
    return this.ownerPublishers > 0
  }

  /** Marks an owner publisher running; the returned stop unmarks it (once). */
  installOwnerPublisher(): () => void {
    this.ownerPublishers += 1
    let installed = true
    return () => {
      if (installed) {
        installed = false
        this.ownerPublishers -= 1
      }
    }
  }

  /** A record the set shows, by its conversation digest or its `pane:<paneKey>` identity. */
  findRecord(worktreeId: string, identity: string): RuntimeSessionConversationRecord | null {
    const buckets = this.view.body.recordsByWorktree
    const records = identity && Object.hasOwn(buckets, worktreeId) ? buckets[worktreeId] : []
    return (
      records?.find(
        (record) => record.conversation === identity || record.paneIdentity === identity
      ) ?? null
    )
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Writes a pending window publication now; resolves once every write so far has settled. */
  flushOwnerLedger(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
      this.writePending()
    }
    return this.writing
  }

  private fallbackView(): LedgerView {
    const last = this.lastWindowPublication()
    if (this.main || !last) {
      return { source: 'main', body: this.main ?? EMPTY_BODY }
    }
    const body = toBody(last)
    // Why incomplete: with no window vouching, an omission from the last listing proves nothing.
    const coverage = body.coverage.map(({ worktreeId }) => ({ worktreeId, complete: false }))
    return { source: 'main', body: { ...body, coverage } }
  }

  /** `published`: a set this incarnation published, which releases the held tombstones (once). */
  private show(view: LedgerView, published = false): boolean {
    const same = view.source === this.view.source && sameBody(view.body, this.view.body)
    const now = this.now()
    const released =
      published && this.removals.release(view.body.recordsByWorktree, this.revision + 1, now)
    if (same && !released) {
      return false
    }
    this.view = view
    // Why here: whether a listed record holds a tombstone back moves only with the shown records.
    this.removals.shield(view.body.recordsByWorktree, this.revision + 1, now)
    this.changed()
    return true
  }

  private changed(): void {
    this.revision += 1
    for (const listener of this.listeners) {
      listener()
    }
  }

  private scheduleWrite(publication: SessionConversationLedgerWindowPublication): void {
    if (!this.ownerLedgerPath) {
      return
    }
    this.pendingWrite = publication
    if (this.writeTimer === null) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null
        this.writePending()
      }, OWNER_LEDGER_PERSIST_DELAY_MS)
      this.writeTimer.unref?.()
    }
  }

  private writePending(): void {
    const file = this.ownerLedgerPath
    const publication = this.pendingWrite
    this.pendingWrite = null
    const json = publication
      ? JSON.stringify({ v: 1, publication } satisfies OwnerLedgerFile)
      : null
    if (!file || !json || json === this.writtenJson) {
      return
    }
    this.writtenJson = json
    // Why chained: writes land in order, so an older publication never replaces a newer one.
    this.writing = this.writing
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => writeFileDurable(durableWriteTempPath(file), file, json))
      .catch((error: unknown) => {
        this.writtenJson = null
        console.warn('[session-host] keeping the owner conversation ledger failed', error)
      })
  }
}
