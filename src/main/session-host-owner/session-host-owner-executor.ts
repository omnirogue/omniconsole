/**
 * The owner service's executor on a paired runtime (package B): what admission reads live and what
 * carries an admitted action out, for the sessions this runtime runs. Every control runs through
 * session-manage's own functions with the caller's actor, so hard stops, markers, unattended
 * policy and drivers behave exactly as they do for a local caller. Transfers and relocation are
 * carried by whatever handlers package C installs; until then they are refused and not advertised.
 */

import { sameConversationSource } from '../../shared/conversation-source'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_STATS_CAPABILITY,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY,
  type SessionHostCapability
} from '../../shared/session-host-capabilities'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import type {
  SessionHostAction,
  SessionHostHistoryParams,
  SessionHostHistoryResult,
  SessionHostTidyParams,
  SessionHostTidyResult,
  SessionHostWaitStatusParams,
  SessionHostWaitStatusResult
} from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostTurnReading } from '../session-host/session-host-admission-facts'
import {
  sessionHostNotSupportedYet,
  type SessionHostExecutionInput,
  type SessionHostExecutor,
  type SessionHostLiveObservation,
  type SessionHostPrepared
} from '../session-host/session-host-executor'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import type { SessionLatestTurn } from '../session-manage/session-manage-freeform'
import { rowHoldsProvider, type HostSessionInventory } from './host-session-inventory'
import type { HostWaitRegistry, HostWaitResultReader } from './host-wait-registry'
import {
  prepareHostAnswer,
  prepareHostRestart,
  prepareHostStop,
  type OwnerControlDeps
} from './session-host-owner-controls'
import {
  prepareHostAsk,
  prepareHostContinue,
  type OwnerDeliveryDeps
} from './session-host-owner-delivery'
import {
  prepareHostOrganization,
  type OwnerOrganizationDeps
} from './session-host-owner-organization'
import { resolveOwnerTarget, type OwnerTarget } from './session-host-owner-target'
import { hostTidy, type OwnerTidyDeps } from './session-host-owner-tidy'
import {
  hostWaitStatus,
  prepareHostWaitCancel,
  prepareHostWaitRegister
} from './session-host-owner-waits'
import { hostAutomationRefusal, remoteControlsOn } from './session-host-switches'
import { sessionHostTurnRevision } from './session-host-turn'

/** Package C's transfers and relocation plug in here; B never imports them. */
export type SessionHostActionHandler = {
  capabilities(): readonly SessionHostCapability[]
  handles(action: SessionHostAction): boolean
  prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared>
  /** Runs after a restart while admission is still closed (a relinquish a crash left unknown). */
  reconcile?(): Promise<void>
}

export type SessionHostOwnerDeps = {
  inventory: HostSessionInventory
  readLatestTurn(
    source: NonNullable<SessionHostRegistration['binding']>
  ): Promise<SessionLatestTurn>
  delivery: OwnerDeliveryDeps
  controls: OwnerControlDeps
  organization: OwnerOrganizationDeps
  tidy: Omit<OwnerTidyDeps, 'inventory' | 'readTurn'>
  waits: HostWaitRegistry
  readWaitResult: HostWaitResultReader
  actionHandlers: readonly SessionHostActionHandler[]
  /** False while startup reconciliation settles what a previous process left in flight. */
  reconciled(): boolean
  /** The runtime's adoption step, run on demand (throttled) as well as on its timer. */
  register?(): Promise<void>
}

export class SessionHostOwnerExecutor implements SessionHostExecutor {
  constructor(private readonly deps: SessionHostOwnerDeps) {}

  capabilities(): readonly SessionHostCapability[] {
    if (!remoteControlsOn()) {
      return []
    }
    return [
      SESSION_CONTROL_OWNER_CAPABILITY,
      ...(this.deps.organization.host() ? [SESSION_ORGANIZATION_HOST_CAPABILITY] : []),
      SESSION_WAITS_REMOTE_CAPABILITY,
      SESSION_HOST_STATS_CAPABILITY,
      ...this.deps.actionHandlers.flatMap((handler) => handler.capabilities())
    ]
  }

  reconciled(): boolean {
    return this.deps.reconciled()
  }

  async register(): Promise<void> {
    await this.deps.register?.()
  }

  private organizationRevision(key: string | undefined): string | null {
    return key
      ? (this.deps.organization.host()?.read([key]).sessions[0]?.organizationRevision ?? null)
      : null
  }

  async readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading> {
    const { binding } = registration
    if (!binding) {
      return { turnRevision: null, organizationRevision: null }
    }
    const [turn, row] = await Promise.all([
      this.deps.readLatestTurn(binding),
      this.deps.inventory.rowFor(binding, registration.provider)
    ])
    return {
      turnRevision: sessionHostTurnRevision(turn),
      organizationRevision: this.organizationRevision(row?.viewKey)
    }
  }

  async observe(
    registrations: readonly SessionHostRegistration[]
  ): Promise<ReadonlyMap<string, SessionHostLiveObservation>> {
    const sessions = await this.deps.inventory.list()
    const observed = new Map<string, SessionHostLiveObservation>()
    for (const registration of registrations) {
      const { binding } = registration
      const session = binding
        ? sessions.find(
            (candidate) =>
              candidate.source &&
              sameConversationSource(candidate.source, binding) &&
              rowHoldsProvider(candidate.row, registration.provider)
          )
        : undefined
      if (!session?.source) {
        // Why unverifiable: no pane here now is not evidence the conversation stopped.
        observed.set(registration.conversationId, { verdict: 'unverifiable', turnRevision: null })
        continue
      }
      const { row, entry } = session
      const organizationRevision = this.organizationRevision(row.viewKey)
      observed.set(registration.conversationId, {
        verdict: entry.verdict,
        turnRevision: sessionHostTurnRevision(await this.deps.readLatestTurn(session.source)),
        ...(organizationRevision ? { organizationRevision } : {}),
        ref: { paneKey: entry.paneKey, tabId: entry.tabId, worktreePath: entry.worktreePath },
        entry,
        archived: row.archived,
        automationDisabled: hostAutomationRefusal(row.folderId) !== null
      })
    }
    return observed
  }

  async prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared> {
    const { request } = input
    const handler = this.deps.actionHandlers.find((candidate) => candidate.handles(request.action))
    if (handler) {
      return await handler.prepare(input)
    }
    const { delivery, controls, organization, waits } = this.deps
    const hostOperation = {
      operationId: input.operation.operationId,
      conversationId: input.operation.conversationId
    }
    switch (request.action) {
      case 'wait.register':
        return prepareHostWaitRegister(waits, request, request.payload)
      case 'wait.cancel':
        return prepareHostWaitCancel(waits, request, request.payload)
      // Why `deliver` too: a paired runtime admits its own writers at its own send door.
      case 'transfer.prepare-source':
      case 'transfer.settle-source':
      case 'relocate.prepare-destination':
      case 'relocate.freeze-source':
      case 'relocate.export':
      case 'relocate.stage':
      case 'relocate.relinquish':
      case 'relocate.resume':
      case 'deliver':
        return { kind: 'refuse', refusal: sessionHostNotSupportedYet(request.action) }
      case 'continue':
        return await this.onTarget(input, (target) =>
          prepareHostContinue(delivery, target, request.payload, hostOperation)
        )
      case 'ask':
        return await this.onTarget(input, (target) =>
          prepareHostAsk(delivery, target, request.payload, hostOperation)
        )
      case 'answer':
        return await this.onTarget(input, (target) =>
          prepareHostAnswer(controls, target, request.payload)
        )
      case 'stop':
        return await this.onTarget(input, (target) =>
          prepareHostStop(controls, target, request.payload)
        )
      case 'restart':
        return await this.onTarget(input, (target) => prepareHostRestart(controls, target))
      case 'rename':
      case 'archive':
      case 'unarchive':
      case 'organize':
      case 'undo':
        return await this.onTarget(input, (target) =>
          prepareHostOrganization(organization, target, request, input.authority)
        )
    }
  }

  /** The conversation's pane here and who acts; a refusal when either is missing or not allowed. */
  private async onTarget(
    input: SessionHostExecutionInput,
    prepare: (target: OwnerTarget) => Promise<SessionHostPrepared>
  ): Promise<SessionHostPrepared> {
    const target = await resolveOwnerTarget({
      inventory: this.deps.inventory,
      registration: input.registration,
      authority: input.authority
    })
    return 'code' in target ? { kind: 'refuse', refusal: target } : await prepare(target)
  }

  async tidy(
    params: SessionHostTidyParams,
    authority: SessionHostAuthority
  ): Promise<SessionHostTidyResult> {
    return await hostTidy(
      {
        ...this.deps.tidy,
        inventory: this.deps.inventory,
        readTurn: (registration) => this.readTurn(registration)
      },
      params,
      authority
    )
  }

  async history(params: SessionHostHistoryParams): Promise<SessionHostHistoryResult> {
    const service = this.deps.tidy.service()
    const host = this.deps.organization.host()
    const registration = service?.store.snapshot()?.conversations[params.conversationId]
    const row = registration?.binding
      ? await this.deps.inventory.rowFor(registration.binding, registration.provider)
      : null
    if (!service || !host || !row) {
      return {
        status: 'refused',
        refusal: sessionHostRefusal(
          'unknown-conversation',
          'That computer holds no organization history for this conversation now.'
        )
      }
    }
    const history = await host.history(row.viewKey)
    const limit = params.limit ?? history.entries.length
    return {
      status: 'ok',
      host: service.identity,
      history: { ...history, entries: history.entries.slice(-limit) }
    }
  }

  async waitStatus(params: SessionHostWaitStatusParams): Promise<SessionHostWaitStatusResult> {
    await this.deps.waits.refresh(this.deps.readWaitResult)
    return hostWaitStatus(this.deps.waits, params)
  }
}
