/**
 * One run of `session relocate`: its durable record, and how each step is sent, recorded and, when
 * a move must stop before relinquishment, undone by releasing the source. The phases themselves
 * are in session-transfer-relocate-phases.ts.
 */

import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import type { SessionHostReceivedObservation } from '../../shared/session-host-reply-schema'
import type {
  SessionRelocationOutcome,
  SessionRelocationResult,
  SessionRelocationStep
} from '../../shared/session-relocation-types'
import {
  runHostStep,
  type HostStepOptions,
  type HostStepOutcome,
  type SessionTransferHostPort
} from './session-transfer-host-port'
import type { SessionRelocationBundleChannel } from './session-transfer-relocate-channel'
import {
  observeRelocationSource,
  relocationRequest,
  relocationResult,
  resultField,
  type RelocationStepRequest
} from './session-transfer-relocate-plan'
import {
  noteRelocationStep,
  type SessionRelocationRecord,
  type SessionRelocationRecords
} from './session-transfer-relocate-record'
import { releaseRelocationSource } from './session-transfer-relocate-release'

export type SessionRelocateDeps = {
  source: SessionTransferHostPort
  destination: SessionTransferHostPort
  channel: SessionRelocationBundleChannel
  records: SessionRelocationRecords
  /** This computer's own relocation switch (its setting and `OMNI_RELOCATION_DISABLED`). */
  relocationEnabled(): boolean
  mintOperationId(): string
  now(): number
  step: HostStepOptions
}

export type SessionRelocateInput = {
  conversationId: string
  /** Built by this computer's main process; an unattended origin only ever proposes. */
  origin: SessionHostOrigin
  workspace: SessionHostPayloads['relocate.prepare-destination']['workspace']
  /** The provider CLI version on the source, which the destination must be able to read. */
  providerVersion: string
  dryRun: boolean
  /** Continue an interrupted move from its record. */
  relocation?: string
}

/** Ends the run with this outcome; the record keeps where it stopped. */
export class RelocationStop extends Error {
  constructor(
    readonly outcome: SessionRelocationOutcome,
    readonly summary: string,
    readonly code?: string
  ) {
    super(summary)
  }
}

export const UNANSWERED = new Set(['unreachable', 'running'])

type SourceAction = 'relocate.freeze-source' | 'relocate.export' | 'relocate.relinquish'
type DestinationAction = 'relocate.prepare-destination' | 'relocate.stage' | 'relocate.resume'

export class RelocationRun {
  record: SessionRelocationRecord | null = null
  observed: SessionHostReceivedObservation | null = null
  readonly source: string
  readonly destination: string

  constructor(
    readonly deps: SessionRelocateDeps,
    readonly input: SessionRelocateInput
  ) {
    this.source = deps.source.label
    this.destination = deps.destination.label
  }

  get current(): SessionRelocationRecord {
    return this.record!
  }

  result(
    outcome: SessionRelocationOutcome,
    summary: string,
    code?: string
  ): SessionRelocationResult {
    return relocationResult(
      this.deps,
      this.input,
      this.record,
      this.observed,
      outcome,
      summary,
      code
    )
  }

  async settle(outcome: SessionRelocationOutcome): Promise<void> {
    if (!this.record || outcome === 'proposed' || outcome === 'planned') {
      return
    }
    this.record.phase = outcome === 'refused' ? 'abandoned' : outcome
    await this.save()
  }

  async save(): Promise<void> {
    this.current.updatedAt = this.deps.now()
    await this.deps.records.write(this.current)
  }

  /** Sends (or resends the recorded) request for one step and records how it ended. */
  async step(
    step: SessionRelocationStep,
    port: SessionTransferHostPort,
    kind: 'execute' | 'reserve',
    build: () => Promise<RelocationStepRequest>
  ): Promise<HostStepOutcome> {
    const record = this.current
    let request = record.requests[step]
    if (!request) {
      request = relocationRequest(await build(), this.deps.mintOperationId(), this.input.origin)
      record.requests[step] = request
      await this.save()
    }
    const outcome = await runHostStep(port, kind, request, this.deps.step)
    const recorded = outcome.kind === 'recorded' || outcome.kind === 'running'
    const detail = recorded ? outcome.operation.refusal?.message : outcome.refusal.message
    noteRelocationStep(record, {
      step,
      operationId: request.operationId,
      state: recorded ? outcome.operation.state : outcome.kind,
      ...(detail ? { detail } : {})
    })
    await this.save()
    return outcome
  }

  /** The source's current turn, re-read before each step it runs under the reservation. */
  async sourceTurn(): Promise<
    Pick<RelocationStepRequest, 'expectedOwnerEpoch' | 'expectedTurnRevision'>
  > {
    const { source } = this.current
    const observed = await observeRelocationSource(this.deps.source, source.conversationId)
    // Why never guessed: a request is recorded as built, and a continuation resends it unchanged.
    if ('stop' in observed) {
      if (observed.code === 'host-unreachable' || observed.code === 'renegotiate') {
        throw new RelocationStop(
          'blocked',
          `${this.source} could not be reached, so nothing more was sent. Continue this move later.`,
          observed.code
        )
      }
      return await this.abandon(null, observed.stop)
    }
    this.observed = observed.row
    return {
      expectedOwnerEpoch: observed.row.ownerEpoch,
      expectedTurnRevision: observed.row.turnRevision
    }
  }

  destinationStep<A extends DestinationAction>(
    step: SessionRelocationStep,
    action: A,
    ownerEpoch: number,
    payload: SessionHostPayloads[A]
  ): Promise<HostStepOutcome> {
    const { conversationId } = this.current.source
    return this.step(
      step,
      this.deps.destination,
      'execute',
      async () =>
        ({
          conversationId,
          expectedOwnerEpoch: ownerEpoch,
          expectedTurnRevision: null,
          action,
          payload
        }) as RelocationStepRequest
    )
  }

  async sourceStep<A extends SourceAction>(
    step: SessionRelocationStep,
    action: A,
    payload: SessionHostPayloads[A]
  ): Promise<HostStepOutcome> {
    const record = this.current
    const outcome = await this.step(
      step,
      this.deps.source,
      'execute',
      async () =>
        ({
          ...(await this.sourceTurn()),
          conversationId: record.source.conversationId,
          reservation: record.reservation,
          action,
          payload
        }) as RelocationStepRequest
    )
    if (UNANSWERED.has(outcome.kind)) {
      throw new RelocationStop(
        'blocked',
        step === 'relinquish'
          ? `${this.source} did not answer whether it handed the conversation over. It never restarts it once it has; continue this move later to find out.`
          : `${this.source} did not answer the ${step} step, so the conversation stays reserved there. Continue this move later.`,
        'host-unreachable'
      )
    }
    return outcome
  }

  /** Only before relinquishment: end the source's reservation so it keeps the conversation. */
  async abandon(outcome: HostStepOutcome | null, what: string): Promise<never> {
    const record = this.current
    const refusal =
      outcome?.kind === 'recorded'
        ? outcome.operation.refusal
        : outcome && 'refusal' in outcome
          ? outcome.refusal
          : undefined
    const reason = refusal?.message ?? resultField<string>(outcome, false, 'reason')
    const why = `The move stopped: ${what}${reason ? ` (${reason.trim().replace(/\.$/, '')})` : ''}.`
    record.releasing = true
    const released = await releaseRelocationSource({
      port: this.deps.source,
      record,
      origin: this.input.origin,
      operationId: this.deps.mintOperationId(),
      step: this.deps.step
    })
    if (!released) {
      throw new RelocationStop(
        'blocked',
        `${why} ${this.source} still reserves the conversation and did not confirm releasing it; continue this move later to release it.`,
        'host-unreachable'
      )
    }
    const touched = record.steps.some((step) => step.step === 'reserve-source')
    throw new RelocationStop(
      touched ? 'abandoned' : 'refused',
      `${why} The conversation stays on ${this.source}${touched ? ', released as it was' : '; nothing was changed there'}.`,
      refusal?.code
    )
  }
}
