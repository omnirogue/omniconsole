import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isRemoteConversationLedgerEnvironmentId,
  readRemoteConversationLedgerSnapshot,
  type RememberConversationLedgerRequest,
  type RemoteConversationLedgerSnapshot
} from '../../shared/remote-conversation-ledger-snapshot'
import { isSessionHostId } from '../../shared/session-host-identity'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

const SNAPSHOT_SUFFIX = '.json'
/** An exit between a durable write's temp file and its rename leaves the temp behind. */
const STALE_TEMP_AGE_MS = 60_000
/** An owner keeps deletions 90 days (F15); a snapshot older than that proves nothing anywhere. */
export const REMOTE_LEDGER_SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** A change that removes nothing waits this long for the burst to settle before an fsync. */
export const REMOTE_LEDGER_SNAPSHOT_DEBOUNCE_MS = 3_000

type SnapshotFile = { v: 1 } & RemoteConversationLedgerSnapshot
type Loaded = {
  snapshots: Map<string, RemoteConversationLedgerSnapshot>
  /** What is on disk for each owner, `savedAt` aside: an unchanged snapshot is not rewritten. */
  written: Map<string, string>
}

/** The snapshot's content, `savedAt` aside: what a write must change to be worth an fsync. */
function content(snapshot: RemoteConversationLedgerSnapshot): string {
  const { savedAt: _savedAt, ...rest } = snapshot
  return JSON.stringify(rest)
}

/**
 * Why its own sweep: writeFileDurable's takes one final path, and this directory holds one file
 * per owner, each with its own temps. This process's temps are skipped (deleting one fails its
 * rename), as is anything younger than a live write could be.
 */
async function sweepStaleTemps(directory: string): Promise<void> {
  const own = `${SNAPSHOT_SUFFIX}.${process.pid}.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter(
        (name) =>
          name.endsWith('.tmp') && name.includes(`${SNAPSHOT_SUFFIX}.`) && !name.includes(own)
      )
      .map(async (name) => {
        const path = join(directory, name)
        const info = await stat(path).catch(() => null)
        if (info && Date.now() - info.mtimeMs >= STALE_TEMP_AGE_MS) {
          await rm(path, { force: true }).catch(() => {})
        }
      })
  )
}

/**
 * Every readable snapshot of an owner still kept; a missing directory, foreign or corrupt file is
 * skipped, an owner no longer in the pairing catalog is left on disk unread (G4: a re-pair may
 * find it) and one older than the retention is removed.
 */
async function readSnapshots(
  directory: string,
  options: { now: () => number; isKept?: (environmentId: string) => boolean }
): Promise<Loaded> {
  const loaded: Loaded = { snapshots: new Map(), written: new Map() }
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return loaded
  }
  for (const name of names) {
    const environmentId = name.endsWith(SNAPSHOT_SUFFIX)
      ? name.slice(0, -SNAPSHOT_SUFFIX.length)
      : ''
    if (
      !isRemoteConversationLedgerEnvironmentId(environmentId) ||
      options.isKept?.(environmentId) === false
    ) {
      continue
    }
    const path = join(directory, name)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SnapshotFile>
      const snapshot = parsed?.v === 1 ? readRemoteConversationLedgerSnapshot(parsed) : null
      // Why the name must match: a renamed or copied file is not that owner's snapshot.
      if (snapshot?.environmentId !== environmentId) {
        continue
      }
      if (options.now() - snapshot.savedAt > REMOTE_LEDGER_SNAPSHOT_RETENTION_MS) {
        await rm(path, { force: true }).catch(() => {})
        continue
      }
      loaded.snapshots.set(environmentId, snapshot)
      loaded.written.set(environmentId, content(snapshot))
    } catch {
      // A corrupt snapshot is ignored: the owner's next live set lists everything again.
    }
  }
  return loaded
}

function ledgerPart(
  from: RememberConversationLedgerRequest | undefined
): Pick<RememberConversationLedgerRequest, 'set' | 'asOf' | 'asOfByWorktree'> {
  return from?.set
    ? {
        set: from.set,
        ...(from.asOf !== undefined ? { asOf: from.asOf } : {}),
        ...(from.asOfByWorktree ? { asOfByWorktree: from.asOfByWorktree } : {})
      }
    : {}
}

function workflowPart(
  from: RememberConversationLedgerRequest | undefined
): Pick<
  RememberConversationLedgerRequest,
  'workflowRecords' | 'workflowsAsOf' | 'workflowsAsOfByWorktree'
> {
  return from?.workflowRecords
    ? {
        workflowRecords: from.workflowRecords,
        ...(from.workflowsAsOf !== undefined ? { workflowsAsOf: from.workflowsAsOf } : {}),
        ...(from.workflowsAsOfByWorktree
          ? { workflowsAsOfByWorktree: from.workflowsAsOfByWorktree }
          : {})
      }
    : {}
}

/**
 * This computer's durable receiver snapshots of paired owners' conversation ledgers and workflow
 * records (session parity, step 5): one file per owner environment, `<environmentId>.json`, written
 * with `writeFileDurable`, read leniently. A request replaces the parts it carries and keeps the
 * others. Each snapshot records the owner's durable journal hostId when known (G4) — this
 * computer's own latest reading of that owner first — so a re-pair can find it later.
 *
 * Why not one fsync per delta: a busy owner republishes on every agent turn. A change that removed
 * rows or captures, added tombstones or changed the catalog (`urgent`) is written at once, so a
 * quit soon after a deletion never restores it; any other waits REMOTE_LEDGER_SNAPSHOT_DEBOUNCE_MS
 * for its burst to settle (later changes ride the same timer), `flush()` — at quit — writes what
 * is still waiting, and a snapshot whose content is what the file already holds is not rewritten.
 */
export class RemoteConversationLedgerStore {
  private loading: Promise<Loaded> | null = null
  /** Owners whose kept snapshot changed since it was last written. */
  private readonly dirty = new Set<string>()
  /** Owners whose change waits for its burst to settle. */
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>()
  private draining = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly opts: {
      directory: string
      now?: () => number
      /** The owner's journal hostId from this computer's own reading of it, when it has one. */
      resolveOwnerHostId?: (environmentId: string) => string | null
      /** Whether an owner is still in the pairing catalog; absent keeps every file. */
      isKept?: (environmentId: string) => boolean
      debounceMs?: number
    }
  ) {
    void sweepStaleTemps(opts.directory)
  }

  async remember(request: RememberConversationLedgerRequest): Promise<void> {
    const { snapshots } = await this.load()
    const previous = snapshots.get(request.environmentId)
    const resolved = this.opts.resolveOwnerHostId?.(request.environmentId)
    const ownerHostId = isSessionHostId(resolved)
      ? resolved
      : (request.ownerHostId ?? previous?.ownerHostId)
    const next: RemoteConversationLedgerSnapshot = {
      environmentId: request.environmentId,
      ...(ownerHostId ? { ownerHostId } : {}),
      ...ledgerPart(request.set ? request : previous),
      ...workflowPart(request.workflowRecords ? request : previous),
      savedAt: (this.opts.now ?? Date.now)()
    }
    // Why: a reconnect or a resume at the same revision keeps nothing new; no timer, no write.
    if (previous && content(previous) === content(next)) {
      return
    }
    snapshots.set(request.environmentId, next)
    if (request.urgent) {
      this.schedule(request.environmentId)
    } else {
      this.defer(request.environmentId)
    }
  }

  /** Every kept snapshot, including ones not written yet. */
  async snapshots(): Promise<RemoteConversationLedgerSnapshot[]> {
    return [...(await this.load()).snapshots.values()]
  }

  /** Writes what still waits, then resolves once every snapshot remembered so far is written. */
  flush(): Promise<void> {
    // Why safe: a Map visits no entry twice, and schedule() deletes only the one being visited.
    for (const environmentId of this.waiting.keys()) {
      this.schedule(environmentId)
    }
    return this.writing
  }

  private load(): Promise<Loaded> {
    this.loading ??= readSnapshots(this.opts.directory, {
      now: this.opts.now ?? Date.now,
      ...(this.opts.isKept ? { isKept: this.opts.isKept } : {})
    })
    return this.loading
  }

  private defer(environmentId: string): void {
    // Why the first change starts the clock and later ones ride it: a burst of deltas costs one
    // write per owner per interval, and an owner that never stops changing still lands.
    if (this.waiting.has(environmentId)) {
      return
    }
    const timer = setTimeout(() => {
      this.waiting.delete(environmentId)
      this.schedule(environmentId)
    }, this.opts.debounceMs ?? REMOTE_LEDGER_SNAPSHOT_DEBOUNCE_MS)
    timer.unref?.()
    this.waiting.set(environmentId, timer)
  }

  /** Coalesced only while a write runs: never a blocked IPC, never a regressing write order. */
  private schedule(environmentId: string): void {
    const timer = this.waiting.get(environmentId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.waiting.delete(environmentId)
    }
    this.dirty.add(environmentId)
    if (!this.draining) {
      this.draining = true
      this.writing = this.writing.then(() => this.drain())
    }
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.takeDirty(); next !== undefined; next = this.takeDirty()) {
        await this.write(next)
      }
    } finally {
      this.draining = false
    }
  }

  private takeDirty(): string | undefined {
    const [next] = this.dirty
    if (next !== undefined) {
      this.dirty.delete(next)
    }
    return next
  }

  /** Writes the newest kept snapshot for one owner; writes land in order and never regress. */
  private async write(environmentId: string): Promise<void> {
    const { snapshots, written } = await this.load()
    const snapshot = snapshots.get(environmentId)
    if (!snapshot || written.get(environmentId) === content(snapshot)) {
      return
    }
    const file = join(this.opts.directory, `${environmentId}${SNAPSHOT_SUFFIX}`)
    try {
      await mkdir(this.opts.directory, { recursive: true })
      await writeFileDurable(
        durableWriteTempPath(file),
        file,
        JSON.stringify({ v: 1, ...snapshot } satisfies SnapshotFile)
      )
      written.set(environmentId, content(snapshot))
    } catch (error) {
      console.warn("[session-host] keeping a paired owner's conversation ledger failed", error)
    }
  }
}
