/**
 * The execution host's organization service (Phase 4, package D; contract in
 * shared/session-organization-host.ts). Every change goes through the same ledger as the
 * window's (trail first, history, ownership), so history, Undo and ownership read the same
 * whether a window applied it or the host did. With no window (an SSH relay, a headless runtime)
 * the ledger's applied record is the change, and the host's values are a fold of those records.
 * Electron-free, so a relay can run it too.
 */

import type { SessionHostSyncEntry } from '../../shared/session-host-sync-doc'
import {
  organizationTargetKey,
  organizationValueAt,
  type OrganizationExecutor,
  type OrganizationHistory,
  type OrganizationKeyState,
  type OrganizationProbeAnswer,
  type OrganizationRecord
} from '../../shared/session-organization-change'
import {
  hostOrganizationAfter,
  hostOrganizationRevision,
  isHostOrganizationKind,
  readHostOrganizationValue,
  type HostOrganizationAdoption,
  type HostOrganizationApi,
  type HostOrganizationMigration,
  type HostOrganizationMigrationResult,
  type HostOrganizationOutcome,
  type HostOrganizationRead,
  type HostOrganizationRequest,
  type HostOrganizationUndoOutcome
} from '../../shared/session-organization-host'
import {
  hostHistoryEntries,
  hostOwnershipEntries,
  hostSyncRevocations,
  hostTitleEntry,
  type HostSyncIngest
} from '../../shared/session-organization-host-sync'
import { sameOwnedValue } from '../../shared/session-organization-ownership'
import { selectOrganizationUndo } from '../../shared/session-organization-undo-plan'
import { pendingHostAdoption, settleHostAdoption } from './host-organization-adoption'
import { commitHostOrganizationChange } from './host-organization-commit'
import { replayHostOrganizationHistory } from './host-organization-delete-catch-up'
import {
  hostOrganizationContext,
  hostOrganizationValuesOf,
  messageOf,
  type HostOrganizationContext,
  type SessionOrganizationHostDeps
} from './host-organization-context'
import { migrateHostOrganization } from './host-organization-migration'
import type { HostOrganizationOutbox } from './host-organization-outbox'

export type { SessionOrganizationHostDeps } from './host-organization-context'

const CHANGED_ON_HOST = 'It changed on this host since.'

export class SessionOrganizationHost implements HostOrganizationApi {
  readonly ready: Promise<void>
  private readonly context: HostOrganizationContext
  private chain: Promise<unknown> = Promise.resolve()
  private readonly stopHearing: () => void

  constructor(deps: SessionOrganizationHostDeps) {
    this.context = hostOrganizationContext(deps)
    this.stopHearing = deps.ledger.onApplied((record) => this.heard(record))
    this.ready = this.start()
  }

  get outbox(): HostOrganizationOutbox {
    return this.context.outbox
  }

  dispose(): void {
    this.stopHearing()
  }

  read(keys?: readonly string[]): HostOrganizationRead {
    const { ledger, view } = this.context
    const pending = ledger.pending()
    const sessions = (keys ?? view.keys()).map((key) => {
      const entry = view.entry(key)
      const digest = this.context.digestOf(key)
      return {
        key,
        ...(digest ? { digest } : {}),
        values: hostOrganizationValuesOf(this.context, key),
        revisions: { ...entry?.revisions },
        organizationRevision: hostOrganizationRevision(entry),
        ownership: ledger.store.stateFor(key),
        pending: pending
          .filter((record) =>
            record.targets.some((target) => organizationTargetKey(target) === key)
          )
          .map((record) => record.opId)
      }
    })
    return { migratedAt: view.migratedAt, sessions }
  }

  apply(request: HostOrganizationRequest): Promise<HostOrganizationOutcome> {
    return this.serial(() => commitHostOrganizationChange(this.context, request))
  }

  /** A key's history merged with the keys it was recorded under before (`pane:…`, `tab:…`). */
  async history(
    key: string,
    options: { aliases?: readonly string[] } = {}
  ): Promise<OrganizationHistory> {
    await this.ready
    const histories = await Promise.all(
      [key, ...(options.aliases ?? [])].map((entry) => this.context.ledger.history(entry))
    )
    const seen = new Set<string>()
    const entries = histories
      .flatMap((history) => history.entries)
      .filter((record) => !seen.has(record.opId) && Boolean(seen.add(record.opId)))
      .sort((left, right) => right.ts.localeCompare(left.ts))
    return { ...histories[0]!, entries, pending: histories.flatMap((history) => history.pending) }
  }

  /** The window's Undo, here: main's plan, each target read again, the inverse committed. */
  undo(
    opId: string,
    options: {
      executor?: OrganizationExecutor
      mintOpId?: string
      expectedOrganizationRevision?: string
    } = {}
  ): Promise<HostOrganizationUndoOutcome> {
    return this.serial(async () => {
      let plan
      try {
        plan = await this.context.ledger.undoPlan(opId)
      } catch (error) {
        return { opId, undone: 0, total: 0, skipped: [], error: messageOf(error) }
      }
      const nowMs = this.context.now().getTime()
      const selection = selectOrganizationUndo(
        plan,
        (kind, target, value) =>
          isHostOrganizationKind(kind) && target.sessionKey
            ? {
                known: true,
                value: readHostOrganizationValue(
                  kind,
                  this.context.view.entry(target.sessionKey),
                  value,
                  nowMs
                )
              }
            : { known: false },
        CHANGED_ON_HOST
      )
      const { skipped, total } = selection
      if (!selection.change) {
        return { opId, undone: 0, total, skipped }
      }
      const outcome = await commitHostOrganizationChange(this.context, {
        ...selection.change,
        executor: options.executor ?? { kind: 'person', via: 'notice' },
        ...(options.mintOpId ? { opId: options.mintOpId } : {}),
        ...(options.expectedOrganizationRevision
          ? { expectedOrganizationRevision: options.expectedOrganizationRevision }
          : {})
      })
      const undone = outcome.status === 'applied' ? selection.kept : 0
      return { opId, undone, total, skipped, outcome }
    })
  }

  migrate(migration: HostOrganizationMigration): Promise<HostOrganizationMigrationResult> {
    return this.serial(async () => {
      // Why its revocations stay unpublished: they are this computer's inference, not a person's act.
      const result = await migrateHostOrganization(this.context, migration)
      // Why durable before answering: automation is admitted from here, even after a crash.
      await Promise.all([this.context.view.flush(), this.context.ledger.flush()])
      return result
    })
  }

  /**
   * Other computers' `t` entries and the account's folder stamps: revocations only (sync
   * receipts never grant ownership). Folder stamps count only while no window runs here; the
   * window's own sync pass hears them otherwise, knowing the stamps it authored. Returns the
   * keys that lost ownership.
   */
  ingest(input: HostSyncIngest & { headless: boolean }): Promise<string[]> {
    return this.serial(async () => {
      const { ledger, view } = this.context
      const keysByDigest = new Map<string, string[]>()
      const keys = new Set([...view.keys(), ...Object.keys(ledger.store.ownership.snapshot())])
      for (const key of keys) {
        const digest = this.context.digestOf(key)
        if (digest) {
          keysByDigest.set(digest, [...(keysByDigest.get(digest) ?? []), key])
        }
      }
      // Why merged: a digest names one session, whichever local key it sits under here.
      const stateOf = (digest: string): OrganizationKeyState | undefined => {
        const states = keysByDigest.get(digest)?.map((key) => ledger.store.stateFor(key))
        return states
          ? {
              ownership: Object.assign({}, ...states.map((state) => state.ownership)),
              revocations: Object.assign({}, ...states.map((state) => state.revocations))
            }
          : undefined
      }
      const found = hostSyncRevocations(
        {
          entries: input.entries,
          ...(input.headless && input.placements ? { placements: input.placements } : {})
        },
        stateOf,
        this.context.hostId
      )
      return ledger.store.updateOwnership((states) =>
        states.revoke(
          found.flatMap(({ digest, field, revocation }) =>
            (keysByDigest.get(digest) ?? []).map((key) => ({ key, field, revocation }))
          )
        )
      )
    })
  }

  /** Headless changes this host's window has not adopted yet, oldest first. */
  async pendingAdoption(): Promise<OrganizationRecord[]> {
    await this.ready
    return pendingHostAdoption(this.context)
  }

  settleAdoption(adoption: HostOrganizationAdoption): Promise<{ restored: string[] }> {
    return this.serial(async () => ({ restored: await settleHostAdoption(this.context, adoption) }))
  }

  /** Entries a caller adds for sync: aliases, result references, policy overrides, a relay's outbox. */
  publish(entries: readonly SessionHostSyncEntry[]): number {
    return this.context.outbox.put(entries)
  }

  /** Publishes the ownership of keys that changed outside a record (seeding, key moves). */
  publishOwnership(keys: readonly string[]): void {
    const entries = keys.flatMap((key) => {
      const digest = this.context.digestOf(key)
      const state = this.context.ledger.store.stateFor(key)
      return digest ? hostOwnershipEntries(digest, state, this.context.hostId) : []
    })
    if (entries.length > 0) {
      this.context.outbox.put(entries)
    }
  }

  /** Names a key's account-sync digest where it has no canonical sidebar identity (a relay's key). */
  noteDigests(pairs: readonly { key: string; digest: string }[]): void {
    for (const { key, digest } of pairs) {
      this.context.view.setDigest(key, digest)
    }
  }

  /** A pane's key folded onto its provider key: its values follow, and its ownership is re-published. */
  noteKeyMoves(moves: readonly { from: string; to: string }[]): void {
    for (const { from, to } of moves) {
      this.context.view.migrateKey(from, to)
    }
    this.publishOwnership(moves.map(({ to }) => to))
  }

  async flush(): Promise<void> {
    await this.ready
    await this.chain
    await this.context.ledger.flush()
    await Promise.all([this.context.view.flush(), this.context.outbox.flush()])
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => this.ready).then(run)
    this.chain = next.catch(() => {})
    return next
  }

  /** Catches the values up from history, then settles headless changes a crash interrupted. */
  private async start(): Promise<void> {
    const { ledger, view } = this.context
    await ledger.ready
    // Why heard, so published too: a crash may have come after the trail line and before the outbox.
    replayHostOrganizationHistory(ledger.store, view, (record) => this.heard(record))
    const nowMs = this.context.now().getTime()
    for (const record of ledger.pending().filter((entry) => entry.headless)) {
      await ledger.resolveInterrupted(record.opId, this.probe(record, nowMs))
    }
  }

  /** A headless change is its applied record: one a crash left prepared holds only if the value does. */
  private probe(record: OrganizationRecord, nowMs: number): OrganizationProbeAnswer {
    const kind = record.kind
    if (!isHostOrganizationKind(kind) || record.targets.length === 0) {
      return { opId: record.opId, holds: false }
    }
    const reads = record.targets.map((target, index) => {
      const key = organizationTargetKey(target)
      const value = organizationValueAt(record, index)
      const intended = hostOrganizationAfter(kind, value)
      const now = key
        ? readHostOrganizationValue(kind, this.context.view.entry(key), value, nowMs)
        : undefined
      return { now, holds: key !== null && intended.ok && sameOwnedValue(now, intended.after) }
    })
    const holds = reads.every((read) => read.holds)
    return { opId: record.opId, holds, ...(holds ? { after: reads.map((read) => read.now) } : {}) }
  }

  /** Every applied record: into the values, and into the outbox for other computers. */
  private heard(record: OrganizationRecord): void {
    const { view, outbox, ledger, hostId } = this.context
    view.fold(record)
    const keyOf = (index: number) => {
      const target = record.targets[index]
      return target ? organizationTargetKey(target) : null
    }
    const entries: SessionHostSyncEntry[] = hostHistoryEntries(
      record,
      this.context.digestOf,
      keyOf,
      hostId
    )
    const touched = new Set(record.targets.map(organizationTargetKey))
    for (const key of touched) {
      const digest = key && !key.startsWith('folder:') ? this.context.digestOf(key) : undefined
      if (!key || !digest) {
        continue
      }
      entries.push(...hostOwnershipEntries(digest, ledger.store.stateFor(key), hostId))
      const title = record.kind === 'title' ? hostTitleEntry(digest, view.entry(key)) : null
      if (title) {
        entries.push(title)
      }
    }
    if (entries.length > 0) {
      outbox.put(entries)
    }
  }
}
