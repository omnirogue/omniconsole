/**
 * The main-process half of the one organization change path: every change is written to the
 * trail as prepared (non-person executors, before it runs) and then applied or failed; applied
 * ones enter the history store. Write order is trail line first, then history, so a crash
 * between the two is repaired from the trail at the next start.
 */

import { join } from 'node:path'
import {
  appliedRevision,
  isOrganizationNoteKind,
  isPersonExecutor,
  ORGANIZATION_INTERRUPTED,
  organizationTargetKey,
  type OrganizationChange,
  type OrganizationHistory,
  type OrganizationProbeAnswer,
  type OrganizationRecord,
  type OrganizationUndoPlan
} from '../../shared/session-organization-change'
import { isRecordedAfterApplying } from '../../shared/session-organization-ownership'
import { sessionActionsLogFor, type SessionActionsLog } from '../session-manage/session-actions-log'
import {
  ORGANIZATION_HISTORY_DIRECTORY,
  OrganizationHistoryStore,
  type OrganizationRecentFilter
} from './organization-history-store'
import {
  organizationTrailLine,
  readOrganizationTrail,
  type OrganizationAudit,
  type OrganizationTrailEntry
} from './organization-trail'
import { assertCurrentRevision } from './organization-revision-check'
import { planOrganizationUndo } from '../../shared/session-organization-undo-plan'
import { aligned, auditOfLine, changeOf, sameTarget } from './organization-ledger-records'

export type OrganizationSettleInput = {
  phase: 'applied' | 'failed'
  /** A person's whole change; for a prepared one its opId, with the targets and value resolved. */
  change: OrganizationChange
  before?: unknown[]
  after?: unknown[]
  error?: string
  /** An older window applied it without the revision check: no ownership. */
  revisionUnchecked?: true
  /** A person's change the host's own applier committed with no window (a prepared one keeps its mark). */
  headless?: true
  audit?: OrganizationAudit
}

export type OrganizationSettled = {
  record: OrganizationRecord
  revision?: string
  /** The change happened but its trail line could not be written. */
  auditError?: string
}

type Held = { record: OrganizationRecord; audit: OrganizationAudit }

/** Hears every applied record as it enters history (not the ones replayed at start). */
export type OrganizationAppliedHook = (record: OrganizationRecord) => void

export class OrganizationChangeLedger {
  /** Settles once the trail has been read: replayed history, interrupted changes listed. */
  readonly ready: Promise<void>
  private readonly inFlight = new Map<string, Held>()
  private readonly interrupted = new Map<string, Held>()
  private readonly appliedHooks = new Set<OrganizationAppliedHook>()

  constructor(
    private readonly options: {
      trail: SessionActionsLog
      store: OrganizationHistoryStore
      now?: () => Date
    }
  ) {
    this.ready = this.recover()
  }

  /** History, ownership and revocations; ownership changes go through its own methods. */
  get store(): OrganizationHistoryStore {
    return this.options.store
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  /** Returns the unsubscribe; a hook that throws never stops the change or the other hooks. */
  onApplied(hook: OrganizationAppliedHook): () => void {
    this.appliedHooks.add(hook)
    return () => this.appliedHooks.delete(hook)
  }

  /** No record, no change: resolves only once the prepared line is written. */
  async prepare(
    change: OrganizationChange,
    extra: { before?: unknown[]; audit?: OrganizationAudit; headless?: true } = {}
  ): Promise<OrganizationRecord> {
    await this.ready
    if (isPersonExecutor(change.executor)) {
      throw new Error('A person’s change is recorded after it applies, never prepared.')
    }
    this.assertNewOpId(change.opId)
    const blocked = [...this.interrupted.values()].find(({ record }) =>
      record.targets.some((held) => change.targets.some((target) => sameTarget(held, target)))
    )
    if (blocked) {
      throw new Error(
        `An earlier change to this target (${blocked.record.opId}) was interrupted and is not reconciled yet. Nothing changed.`
      )
    }
    assertCurrentRevision(change, this.store)
    const record: OrganizationRecord = {
      ...change,
      phase: 'prepared',
      ts: this.now(),
      ...aligned('before', extra.before, change.targets),
      ...(extra.headless ? { headless: true as const } : {})
    }
    const audit = extra.audit ?? {}
    try {
      await this.options.trail.appendStrict(organizationTrailLine(record, audit))
    } catch (error) {
      throw new Error(
        `Nothing changed: the change could not be recorded first (${error instanceof Error ? error.message : String(error)}).`
      )
    }
    this.inFlight.set(change.opId, { record, audit })
    return record
  }

  /** Writes the terminal phase; an applied change enters history and returns its revision. */
  async settle(input: OrganizationSettleInput): Promise<OrganizationSettled> {
    await this.ready
    const { change } = input
    const held = this.inFlight.get(change.opId)
    let base: OrganizationChange
    if (isRecordedAfterApplying(change.executor) && !held) {
      this.assertNewOpId(change.opId)
      base = change
    } else if (held) {
      // Why the prepared copy wins: who acted and why were fixed before the change ran.
      base = {
        ...changeOf(held.record),
        targets: change.targets.length > 0 ? change.targets : held.record.targets,
        value: change.value !== undefined ? change.value : held.record.value,
        ...(change.values ? { values: change.values } : {})
      }
    } else {
      throw new Error(`No prepared change ${change.opId} to settle.`)
    }
    const record: OrganizationRecord = {
      ...base,
      phase: input.phase,
      ts: this.now(),
      ...aligned('before', input.before ?? held?.record.before, base.targets),
      ...aligned('after', input.after, base.targets),
      ...(input.phase === 'applied'
        ? { revision: appliedRevision(base) }
        : { error: input.error ?? 'failed' }),
      ...(input.revisionUnchecked ? { revisionUnchecked: true as const } : {}),
      ...(held?.record.headless || input.headless ? { headless: true as const } : {})
    }
    this.inFlight.delete(change.opId)
    const auditError = await this.options.trail.append(
      organizationTrailLine(record, { ...held?.audit, ...input.audit })
    )
    if (record.phase === 'applied') {
      this.addApplied(record)
    }
    return {
      record,
      ...(record.revision ? { revision: record.revision } : {}),
      ...(auditError ? { auditError } : {})
    }
  }

  /**
   * A history-only record (`isOrganizationNoteKind`) of something the app already did: one
   * applied line, then history. Nothing is prepared first because nothing organized changes, and
   * no applied hook hears it: the host folds and syncs organized values only.
   */
  async note(change: OrganizationChange, audit?: OrganizationAudit): Promise<OrganizationSettled> {
    await this.ready
    if (!isOrganizationNoteKind(change.kind)) {
      throw new Error(`A ${change.kind} is an organization change, not a note.`)
    }
    this.assertNewOpId(change.opId)
    const record: OrganizationRecord = { ...change, phase: 'applied', ts: this.now() }
    const auditError = await this.options.trail.append(organizationTrailLine(record, audit))
    this.store.add(record)
    return { record, ...(auditError ? { auditError } : {}) }
  }

  /** Prepared before a crash, with no applied or failed line: no ownership, no Undo yet. */
  pending(): OrganizationRecord[] {
    return [...this.interrupted.values()].map(({ record }) => record)
  }

  /** Applied (reconciled) when the window confirms the target holds the value, else failed. */
  async resolveInterrupted(
    opId: string,
    answer: OrganizationProbeAnswer | undefined
  ): Promise<OrganizationRecord | null> {
    const held = this.interrupted.get(opId)
    if (!held) {
      return null
    }
    this.interrupted.delete(opId)
    const base = changeOf(held.record)
    const holds = answer?.holds === true
    const targets = holds && answer.targets?.length ? answer.targets : base.targets
    const record: OrganizationRecord = holds
      ? {
          ...base,
          targets,
          value: answer.value !== undefined ? answer.value : base.value,
          phase: 'applied',
          ts: this.now(),
          ...aligned('before', held.record.before, targets),
          ...aligned('after', answer.after, targets),
          revision: appliedRevision(base),
          reconciled: true,
          ...(held.record.headless ? { headless: true as const } : {})
        }
      : { ...base, phase: 'failed', ts: this.now(), error: ORGANIZATION_INTERRUPTED }
    await this.options.trail.append(organizationTrailLine(record, held.audit))
    if (record.phase === 'applied') {
      this.addApplied(record)
    }
    return record
  }

  async history(key: string): Promise<OrganizationHistory> {
    await this.ready
    return {
      key,
      entries: this.store.entriesFor(key),
      ...this.store.stateFor(key),
      pending: this.pending().filter((record) =>
        record.targets.some((target) => organizationTargetKey(target) === key)
      )
    }
  }

  async recent(filter: OrganizationRecentFilter): Promise<OrganizationRecord[]> {
    await this.ready
    return this.store.recent(filter)
  }

  async undoPlan(opId: string): Promise<OrganizationUndoPlan> {
    await this.ready
    if (this.interrupted.has(opId)) {
      throw new Error(
        `Change ${opId} was interrupted and is not reconciled yet, so it cannot be undone.`
      )
    }
    if (this.inFlight.has(opId)) {
      throw new Error(`Change ${opId} is still being applied.`)
    }
    const record = this.store.get(opId)
    if (!record) {
      throw new Error(`No applied change ${opId} is in the session history.`)
    }
    return planOrganizationUndo(record, (key, field) => this.store.latestFor(key, field))
  }

  async flush(): Promise<void> {
    await this.ready
    await this.options.trail.flush()
    await this.store.flush()
  }

  private addApplied(record: OrganizationRecord): void {
    if (this.store.has(record.opId)) {
      return
    }
    this.store.add(record)
    for (const hook of this.appliedHooks) {
      try {
        hook(record)
      } catch (error) {
        console.error('[session-organization] an applied-change hook failed', error)
      }
    }
  }

  private assertNewOpId(opId: string): void {
    if (this.inFlight.has(opId) || this.interrupted.has(opId) || this.store.has(opId)) {
      throw new Error(`Change ${opId} was already recorded.`)
    }
  }

  private async recover(): Promise<void> {
    let entries: OrganizationTrailEntry[]
    try {
      entries = await readOrganizationTrail(this.options.trail.path)
    } catch (error) {
      console.error('[session-organization] reading the change trail failed', error)
      return
    }
    const watermark = this.store.appliedThrough
    const prepared = new Map<string, OrganizationTrailEntry>()
    const terminal = new Set<string>()
    for (const entry of entries) {
      const { record } = entry
      if (record.phase === 'prepared') {
        prepared.set(record.opId, prepared.get(record.opId) ?? entry)
        continue
      }
      terminal.add(record.opId)
      // Why the watermark: an older applied line missing from history was pruned, not lost.
      if (record.phase === 'applied' && (watermark === null || record.ts >= watermark)) {
        this.store.add(record)
      }
    }
    for (const [opId, entry] of prepared) {
      if (!terminal.has(opId) && !this.store.has(opId)) {
        this.interrupted.set(opId, { record: entry.record, audit: auditOfLine(entry.line) })
      }
    }
  }
}

const ledgers = new Map<string, OrganizationChangeLedger>()

/** One ledger per profile directory, sharing that directory's trail so lines stay in order. */
export function sessionOrganizationLedgerFor(userDataPath: string): OrganizationChangeLedger {
  let ledger = ledgers.get(userDataPath)
  if (!ledger) {
    const store = new OrganizationHistoryStore({
      directory: join(userDataPath, ORGANIZATION_HISTORY_DIRECTORY)
    })
    store.load()
    ledger = new OrganizationChangeLedger({ trail: sessionActionsLogFor(userDataPath), store })
    ledgers.set(userDataPath, ledger)
  }
  return ledger
}

/** Loads history and reads the trail at app start; returns the flush for quit. */
export function startSessionOrganization(userDataPath: string): () => Promise<void> {
  const ledger = sessionOrganizationLedgerFor(userDataPath)
  return () => ledger.flush()
}
