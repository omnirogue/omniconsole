/**
 * Handoff and consolidation sources that run under a session host (another computer, or this
 * one's own registry). Each is reserved durably at its own host, asked for its brief there under
 * that reservation, rechecked against its brief's checkpoint before the target gets anything, and
 * settled there: archived once the target accepted, released when the transfer is abandoned. A
 * host that does not answer leaves its source untouched and `unresolved`; continuing the transfer
 * resends that same settle request and never asks for a brief again.
 */

import type { SessionHostRequest } from '../../shared/session-host-protocol'
import type { SessionTransferHostSourceReceipt } from '../../shared/session-transfer-types'
import { SessionManageRefusal } from './session-manage-refusal'
import type { SessionTransferMode } from './session-manage-transfer-contract'
import {
  runHostStep,
  type HostStepOutcome,
  type SessionTransferHostPort
} from './session-transfer-host-port'
import {
  refusalOf,
  UNANSWERED,
  type HostSourceEntry,
  type HostTransferDeps,
  type HostTransferSource,
  type SessionTransferHostRecord,
  type TargetReceipt
} from './session-transfer-host-source-record'

export {
  canonicalHostOrder,
  type HostTransferDeps,
  type HostTransferSource,
  type SessionTransferHostRecord
} from './session-transfer-host-source-record'

export class HostTransferSources {
  private constructor(
    private readonly deps: HostTransferDeps,
    readonly record: SessionTransferHostRecord,
    private readonly ports: ReadonlyMap<string, SessionTransferHostPort>
  ) {}

  static async start(
    deps: HostTransferDeps,
    mode: SessionTransferMode,
    target: SessionTransferHostRecord['target'],
    sources: readonly HostTransferSource[]
  ): Promise<HostTransferSources> {
    const record: SessionTransferHostRecord = {
      v: 1,
      transfer: deps.mintOperationId(),
      mode,
      target,
      sources: sources.map((source) => ({
        hostId: source.port.hostId,
        label: source.port.label,
        conversationId: source.conversationId,
        title: source.title
      })),
      updatedAt: deps.now()
    }
    const ports = new Map(sources.map((source) => [source.port.hostId, source.port]))
    const started = new HostTransferSources(deps, record, ports)
    await started.save()
    return started
  }

  /** Picks an earlier transfer back up; `portFor` reaches each source's host again. */
  static async resume(
    deps: HostTransferDeps,
    transfer: string,
    portFor: (hostId: string) => SessionTransferHostPort | null
  ): Promise<HostTransferSources | null> {
    const record = await deps.records.read(transfer)
    if (!record) {
      return null
    }
    const ports = new Map<string, SessionTransferHostPort>()
    for (const source of record.sources) {
      const port = portFor(source.hostId)
      if (port) {
        ports.set(source.hostId, port)
      }
    }
    return new HostTransferSources(deps, record, ports)
  }

  get transfer(): string {
    return this.record.transfer
  }

  private async save(): Promise<void> {
    this.record.updatedAt = this.deps.now()
    await this.deps.records.write(this.record)
  }

  private entry(conversationId: string): HostSourceEntry {
    return this.record.sources.find((source) => source.conversationId === conversationId)!
  }

  private async send(
    entry: HostSourceEntry,
    field: 'reserve' | 'prepare' | 'settle' | 'release',
    build: () => Promise<Omit<SessionHostRequest, 'operationId' | 'origin'>>
  ): Promise<HostStepOutcome> {
    const port = this.ports.get(entry.hostId)
    if (!port) {
      return {
        kind: 'unreachable',
        refusal: { code: 'host-unreachable', message: `${entry.label} is not connected.` }
      }
    }
    entry[field] ??= {
      ...(await build()),
      operationId: this.deps.mintOperationId(),
      origin: this.deps.origin
    } as SessionHostRequest
    await this.save()
    return await runHostStep(
      port,
      field === 'reserve' ? 'reserve' : 'execute',
      entry[field]!,
      this.deps.step
    )
  }

  private async current(entry: HostSourceEntry) {
    const port = this.ports.get(entry.hostId)
    const reply = port ? await port.observe({ conversationIds: [entry.conversationId] }) : null
    return reply?.status === 'ok'
      ? (reply.sessions.find((session) => session.conversationId === entry.conversationId) ?? null)
      : undefined
  }

  /** Reserves one source at its host; refuses (throws) when it cannot be reserved now. */
  async reserve(conversationId: string): Promise<void> {
    const entry = this.entry(conversationId)
    const row = await this.current(entry)
    const name = `“${entry.title}” on ${entry.label}`
    if (row === undefined || row === null) {
      throw new SessionManageRefusal(
        `${name} ${row === undefined ? 'could not be reached' : 'is not run by that computer'}, so it was left untouched.`
      )
    }
    const outcome = await this.send(entry, 'reserve', async () => ({
      conversationId,
      expectedOwnerEpoch: row.ownerEpoch,
      expectedTurnRevision: row.turnRevision,
      action: 'transfer.prepare-source',
      payload: { transfer: this.transfer, mode: this.record.mode, target: this.record.target }
    }))
    if (outcome.kind !== 'recorded' || outcome.operation.state !== 'admitted') {
      // Why only a definite answer: an unanswered reserve may hold there, so it is still released.
      if (!UNANSWERED.has(outcome.kind)) {
        entry.reserved = false
        await this.save()
      }
      throw new SessionManageRefusal(`${name} could not be reserved: ${refusalOf(outcome)}`)
    }
    entry.reserved = true
    await this.save()
  }

  /** Asks the source for its brief at its host, under its reservation. */
  async brief(conversationId: string): Promise<string> {
    const entry = this.entry(conversationId)
    const outcome = await this.send(entry, 'prepare', async () => {
      const row = await this.current(entry)
      // Why never guessed: the request is recorded as built and only ever resent unchanged.
      if (!row) {
        throw new Error(`“${entry.title}” on ${entry.label} could not be read before its brief.`)
      }
      return {
        conversationId,
        expectedOwnerEpoch: row.ownerEpoch,
        expectedTurnRevision: row.turnRevision,
        reservation: entry.reserve!.operationId,
        action: 'transfer.prepare-source',
        payload: { transfer: this.transfer, mode: this.record.mode, target: this.record.target }
      }
    })
    const result = (outcome.kind === 'recorded' ? outcome.operation.result : undefined) as
      | { brief?: unknown; checkpoint?: unknown }
      | undefined
    if (typeof result?.brief !== 'string' || typeof result.checkpoint !== 'string') {
      throw new Error(`“${entry.title}” on ${entry.label} gave no brief: ${refusalOf(outcome)}`)
    }
    Object.assign(entry, { brief: result.brief, checkpoint: result.checkpoint })
    await this.save()
    return result.brief
  }

  /** Right before the target gets the brief: every source still where its brief left it. */
  async recheck(): Promise<void> {
    for (const entry of this.record.sources.filter((source) => source.reserved)) {
      const row = await this.current(entry)
      const held = row?.reservation?.operationId === entry.reserve?.operationId
      if (!row || row.turnRevision !== entry.checkpoint || !held) {
        throw new SessionManageRefusal(
          `“${entry.title}” on ${entry.label} ${row === undefined ? 'could not be reached to confirm' : 'changed since'} its brief, so the brief was not sent.`
        )
      }
    }
  }

  /** Settles every source at its own host; an unanswered one stays unresolved, never resent. */
  async settle(
    decided: 'accepted' | 'abandoned',
    targetReceipt?: TargetReceipt
  ): Promise<SessionTransferHostSourceReceipt[]> {
    this.record.decided ??= decided
    this.record.targetReceipt ??= targetReceipt
    for (const entry of this.record.sources) {
      if (entry.receipt && entry.receipt.state !== 'unresolved') {
        continue
      }
      entry.receipt = await this.settleOne(entry)
      await this.save()
    }
    return this.receipts()
  }

  private async settleOne(entry: HostSourceEntry): Promise<SessionTransferHostSourceReceipt> {
    const receipt = (state: SessionTransferHostSourceReceipt['state'], detail?: string) => ({
      hostId: entry.hostId,
      label: entry.label,
      conversationId: entry.conversationId,
      title: entry.title,
      state,
      ...(detail ? { detail } : {})
    })
    if (!entry.reserve || entry.reserved === false) {
      return receipt('released', 'It was never reserved.')
    }
    const accepted = this.record.decided === 'accepted' && entry.brief !== undefined
    const settle = (field: 'settle' | 'release', accept: boolean) =>
      this.send(entry, field, async () => ({
        conversationId: entry.conversationId,
        expectedOwnerEpoch: entry.reserve!.expectedOwnerEpoch,
        expectedTurnRevision: entry.checkpoint ?? entry.reserve!.expectedTurnRevision,
        reservation: entry.reserve!.operationId,
        action: 'transfer.settle-source',
        payload: accept
          ? {
              transfer: this.transfer,
              outcome: 'accepted',
              targetReceipt: this.record.targetReceipt!
            }
          : { transfer: this.transfer, outcome: 'abandoned' }
      }))
    let outcome = await settle('settle', accepted)
    let refused: string | undefined
    if (accepted && outcome.kind !== 'recorded' && !UNANSWERED.has(outcome.kind)) {
      refused = refusalOf(outcome)
    } else if (accepted && outcome.kind === 'recorded' && outcome.operation.state === 'refused') {
      refused = refusalOf(outcome)
    }
    if (refused) {
      // Why abandon it: the target accepted, but this source moved on since its brief, so it stays.
      outcome = await settle('release', false)
    }
    if (UNANSWERED.has(outcome.kind)) {
      return receipt(
        'unresolved',
        `${entry.label} did not answer, so its reservation may still hold there.`
      )
    }
    const result = (outcome.kind === 'recorded' ? outcome.operation.result : undefined) as
      | { settled?: unknown; archived?: unknown; detail?: unknown }
      | undefined
    if (result?.settled === 'accepted') {
      return result.archived === true
        ? receipt('archived')
        : receipt(
            'kept',
            typeof result.detail === 'string' ? result.detail : 'It was not archived.'
          )
    }
    const row = await this.current(entry)
    const stillHeld =
      row === undefined || row?.reservation?.operationId === entry.reserve.operationId
    const detail = refused ?? (result?.settled === 'abandoned' ? undefined : refusalOf(outcome))
    return stillHeld && result?.settled !== 'abandoned'
      ? receipt('unresolved', detail)
      : receipt(refused ? 'kept' : 'released', detail)
  }

  receipts(): SessionTransferHostSourceReceipt[] {
    return this.record.sources.flatMap((entry) => (entry.receipt ? [entry.receipt] : []))
  }
}
