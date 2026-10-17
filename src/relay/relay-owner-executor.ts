/**
 * The owner service's executor on an SSH relay (package B2): the relay's own evidence for what
 * admission reads, and the controls it can carry out itself. It advertises owner control and waits;
 * organization stays with the Macs until a relay holds organization values (not advertised, so a
 * Mac is told plainly). `answer` needs the question on the screen, which a relay does not model.
 * Moving a conversation away (B3) is carried by the installed action handlers (package C's steps).
 */

import {
  SESSION_CONTROL_DELIVERY_CAPABILITY,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_STATS_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY,
  type SessionHostCapability
} from '../shared/session-host-capabilities'
import type {
  SessionHostWaitStatusParams,
  SessionHostWaitStatusResult
} from '../shared/session-host-protocol'
import { sessionHostRefusal } from '../shared/session-host-refusal'
import type { SessionHostTurnReading } from '../main/session-host/session-host-admission-facts'
import {
  sessionHostNotSupportedYet,
  type SessionHostExecutionInput,
  type SessionHostExecutor,
  type SessionHostLiveObservation,
  type SessionHostPrepared
} from '../main/session-host/session-host-executor'
import type { SessionHostRegistration } from '../main/session-host/session-host-journal'
import type { SessionHostActionHandler } from '../main/session-manage/session-transfer-host-action-deps'
import { unattendedContextFor } from '../main/session-manage/session-manage-unattended'
import type {
  HostWaitRegistry,
  HostWaitResultReader
} from '../main/session-host-owner/host-wait-registry'
import { sessionHostActor } from '../main/session-host-owner/session-host-actor'
import {
  hostWaitStatus,
  prepareHostWaitCancel,
  prepareHostWaitRegister
} from '../main/session-host-owner/session-host-owner-waits'
import { remoteControlsOn } from '../main/session-host-owner/session-host-switches'
import {
  prepareRelayAsk,
  prepareRelayContinue,
  prepareRelayDeliver,
  prepareRelayRestart,
  prepareRelayStop,
  type RelayControlDeps
} from './relay-owner-controls'
import { relayOwnerEntry, relayOwnerSession, type RelayOwnerSession } from './relay-owner-sessions'

export type RelayOwnerExecutorDeps = RelayControlDeps & {
  waits: HostWaitRegistry
  readWaitResult: HostWaitResultReader
  reconciled(): boolean
  /** Package C's transfer and relocation steps; absent ones are refused and not advertised. */
  actionHandlers?: readonly SessionHostActionHandler[]
}

const UNATTENDED_MOVE = sessionHostRefusal(
  'unattended-restricted',
  'An automatic caller may only propose moving a conversation; a person starts the move. Nothing was changed.'
)

export class RelaySessionHostExecutor implements SessionHostExecutor {
  constructor(private readonly deps: RelayOwnerExecutorDeps) {}

  capabilities(): readonly SessionHostCapability[] {
    return remoteControlsOn()
      ? [
          SESSION_CONTROL_OWNER_CAPABILITY,
          SESSION_WAITS_REMOTE_CAPABILITY,
          SESSION_CONTROL_DELIVERY_CAPABILITY,
          SESSION_HOST_STATS_CAPABILITY,
          ...(this.deps.actionHandlers ?? []).flatMap((handler) => handler.capabilities())
        ]
      : []
  }

  reconciled(): boolean {
    return this.deps.reconciled()
  }

  private session(registration: SessionHostRegistration): RelayOwnerSession | null {
    const paneKey = registration.binding?.paneKey
    return paneKey ? relayOwnerSession(this.deps.facts, this.deps.turns, paneKey) : null
  }

  async readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading> {
    return {
      turnRevision: this.session(registration)?.turnRevision ?? null,
      organizationRevision: null
    }
  }

  async observe(
    registrations: readonly SessionHostRegistration[]
  ): Promise<ReadonlyMap<string, SessionHostLiveObservation>> {
    const observed = new Map<string, SessionHostLiveObservation>()
    for (const registration of registrations) {
      const session = this.session(registration)
      if (!session) {
        observed.set(registration.conversationId, { verdict: 'unverifiable', turnRevision: null })
        continue
      }
      observed.set(registration.conversationId, {
        verdict: session.verdict,
        turnRevision: session.turnRevision,
        ref: { paneKey: session.paneKey, tabId: session.pane?.tabId ?? null },
        entry: relayOwnerEntry(this.deps.facts, session)
      })
    }
    return observed
  }

  async prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared> {
    const { request, registration } = input
    const actor = sessionHostActor(input.authority)
    const handler = this.deps.actionHandlers?.find((candidate) => candidate.handles(request.action))
    if (handler) {
      // Why refused here: freezing ends the agent, and a relay takes no stop from an automatic caller.
      return unattendedContextFor(actor)
        ? { kind: 'refuse', refusal: UNATTENDED_MOVE }
        : await handler.prepare(input)
    }
    const session = registration ? this.session(registration) : null
    const noPane = {
      kind: 'refuse' as const,
      refusal: sessionHostRefusal(
        'not-eligible',
        'That SSH host holds no pane for this conversation now, so nothing was done.'
      )
    }
    switch (request.action) {
      case 'wait.register':
        return prepareHostWaitRegister(this.deps.waits, request, request.payload)
      case 'wait.cancel':
        return prepareHostWaitCancel(this.deps.waits, request, request.payload)
      case 'continue':
        return session
          ? await prepareRelayContinue(this.deps, session, actor, input.marker, request.payload)
          : noPane
      case 'ask':
        return session ? await prepareRelayAsk(this.deps, session, actor, request.payload) : noPane
      case 'deliver':
        return session
          ? await prepareRelayDeliver(this.deps, session, actor, request.payload)
          : noPane
      case 'stop':
        return session ? await prepareRelayStop(this.deps, session, actor, request.payload) : noPane
      case 'restart':
        return session ? await prepareRelayRestart(this.deps, session, actor) : noPane
      case 'answer':
        return {
          kind: 'refuse',
          refusal: sessionHostRefusal(
            'not-eligible',
            'An SSH host cannot read the question on its screen; answer it from a Mac that shows the session. Nothing was sent.'
          )
        }
      case 'rename':
      case 'archive':
      case 'unarchive':
      case 'organize':
      case 'undo':
      case 'transfer.prepare-source':
      case 'transfer.settle-source':
      case 'relocate.prepare-destination':
      case 'relocate.freeze-source':
      case 'relocate.export':
      case 'relocate.stage':
      case 'relocate.relinquish':
      case 'relocate.resume':
        return { kind: 'refuse', refusal: sessionHostNotSupportedYet(request.action) }
    }
  }

  async waitStatus(params: SessionHostWaitStatusParams): Promise<SessionHostWaitStatusResult> {
    await this.deps.waits.refresh(this.deps.readWaitResult)
    return hostWaitStatus(this.deps.waits, params)
  }
}
