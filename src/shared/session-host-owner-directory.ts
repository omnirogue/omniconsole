/**
 * What a requesting Mac knows about who owns what. Connections are aliases of a host exactly when
 * they advertise the same registry `hostId` (two SSH names, a relay and a paired runtime on one
 * account), so they resolve to one owner. A conversation's owner changes only when another host
 * reports it at a strictly higher owner epoch (a consumed relocation grant): silence, refusals and
 * lost replies never move it, and only the owner's own answer can say `live` or `exited`.
 */

import type { SessionHostIdentity } from './session-host-identity'
import type { SessionHostReceivedObservation } from './session-host-reply-schema'
import { sessionHostVerdictOf, type SessionExecutionVerdict } from './session-host-verdict'

export type SessionHostOwner = { hostId: string; ownerEpoch: number }

type ObserveReply =
  | { status: 'ok'; host: SessionHostIdentity; sessions: readonly SessionHostReceivedObservation[] }
  | { status: 'refused' }

export class SessionHostOwnerDirectory {
  private readonly hostByConnection = new Map<string, string>()
  private readonly owners = new Map<string, SessionHostOwner>()

  /** From a negotiation: which registry this connection reaches (null: none advertised). */
  noteConnection(connection: string, host: SessionHostIdentity | null): void {
    if (host) {
      this.hostByConnection.set(connection, host.hostId)
    } else {
      this.hostByConnection.delete(connection)
    }
  }

  hostOf(connection: string): string | null {
    return this.hostByConnection.get(connection) ?? null
  }

  /** Every connection that reaches the same host: aliases, one owner. */
  connectionsOf(hostId: string): string[] {
    return [...this.hostByConnection]
      .filter(([, host]) => host === hostId)
      .map(([connection]) => connection)
  }

  noteObservation(reply: ObserveReply | null | undefined): void {
    if (reply?.status !== 'ok') {
      return
    }
    for (const row of reply.sessions) {
      const current = this.owners.get(row.conversationId)
      const sameHost = current?.hostId === reply.host.hostId
      if (
        !current ||
        (sameHost && row.ownerEpoch >= current.ownerEpoch) ||
        row.ownerEpoch > current.ownerEpoch
      ) {
        this.owners.set(row.conversationId, {
          hostId: reply.host.hostId,
          ownerEpoch: row.ownerEpoch
        })
      }
    }
  }

  ownerOf(conversationId: string): SessionHostOwner | null {
    return this.owners.get(conversationId) ?? null
  }

  /** `unverifiable` unless this answer is the owning host's own, at the owner's epoch. */
  verdictOf(
    conversationId: string,
    reply: ObserveReply | null | undefined
  ): SessionExecutionVerdict {
    const owner = this.owners.get(conversationId)
    if (!owner || reply?.status !== 'ok' || reply.host.hostId !== owner.hostId) {
      return 'unverifiable'
    }
    const row = reply.sessions.find((session) => session.conversationId === conversationId)
    return row && row.ownerEpoch === owner.ownerEpoch
      ? sessionHostVerdictOf(reply, conversationId)
      : 'unverifiable'
  }
}
