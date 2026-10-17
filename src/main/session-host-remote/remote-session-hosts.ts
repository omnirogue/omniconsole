/**
 * The requesting Mac's view of the other computers that run its sessions (Phase 4 E): one
 * `SessionHostClient` per execution host key (`runtime:<env>`, `ssh:<target>`), one owner
 * directory, and each host's last reading for the Work card. Readings are bounded (a few hosts at
 * a time, never more often than `REMOTE_HOST_REFRESH_MS`) and summarised per host, so a hundred
 * sessions on other computers are one line each, not a hundred alerts.
 */

import { randomUUID } from 'node:crypto'
import { conversationDeliveryOperationId } from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  SessionHostClient,
  type SessionHostClientTransport
} from '../../shared/session-host-client'
import { SESSION_CONTROL_OWNER_CAPABILITY } from '../../shared/session-host-capability-names'
import type { SessionHostNegotiation } from '../../shared/session-host-negotiation'
import { SessionHostOwnerDirectory } from '../../shared/session-host-owner-directory'
import type { SessionHostReceivedObservation } from '../../shared/session-host-reply-schema'
import {
  EMPTY_REMOTE_HOST_COUNTS,
  type RemoteHostCounts,
  type RemoteHostSnapshot,
  type RemoteHostState
} from '../../shared/session-hosts-status'

export const REMOTE_HOST_REFRESH_MS = 60_000
const REFRESH_CONCURRENCY = 3

export type RemoteSessionHostsDeps = {
  /** Null when this key names no computer this Mac can reach (local, unknown, malformed). */
  connect(hostKey: string): Promise<SessionHostClientTransport | null>
  now(): number
}

type Known = { client: SessionHostClient; snapshot: RemoteHostSnapshot }

export function remoteHostState(negotiation: SessionHostNegotiation | null): {
  state: RemoteHostState
  detail?: string
} {
  if (!negotiation) {
    return { state: 'unreachable' }
  }
  if (negotiation.peerStatus !== 'advertised') {
    return {
      state: 'older',
      ...(negotiation.detail ? { detail: negotiation.detail } : {})
    }
  }
  return negotiation.agreed.includes(SESSION_CONTROL_OWNER_CAPABILITY)
    ? { state: 'ready' }
    : { state: 'controls-off' }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Counts by the owner's verdict and by the state its own projection reports. */
export function remoteHostCounts(
  sessions: readonly SessionHostReceivedObservation[]
): RemoteHostCounts {
  const counts = { ...EMPTY_REMOTE_HOST_COUNTS }
  for (const row of sessions) {
    counts.total += 1
    counts[row.verdict] += 1
    const state = text(row.entry?.state)
    if (state === 'working') {
      counts.working += 1
    } else if (state === 'awaiting-user' || state === 'waiting-for-yes') {
      counts.needsYou += 1
    }
    if (row.entry?.stalled && typeof row.entry.stalled === 'object') {
      counts.stalled += 1
    }
  }
  return counts
}

export class RemoteSessionHosts {
  readonly directory = new SessionHostOwnerDirectory()
  private readonly known = new Map<string, Known>()
  private refreshing: Promise<void> | null = null

  constructor(private readonly deps: RemoteSessionHostsDeps) {}

  newOperationId(): string {
    return conversationDeliveryOperationId('same-session', randomUUID(), this.deps.now())
  }

  /** The client for a host key, created on first use; null when it names no remote computer. */
  async clientFor(hostKey: string): Promise<SessionHostClient | null> {
    const existing = this.known.get(hostKey)
    if (existing) {
      return existing.client
    }
    const host = parseExecutionHostId(hostKey)
    if (!host || host.kind === 'local') {
      return null
    }
    const transport = await this.deps.connect(hostKey)
    if (!transport) {
      return null
    }
    const client = new SessionHostClient(transport)
    this.known.set(hostKey, {
      client,
      snapshot: {
        hostKey,
        kind: host.kind,
        state: 'checking',
        capabilities: [],
        checkedAt: null,
        counts: null
      }
    })
    return client
  }

  /** One reading of a host: its negotiation and, when it speaks owner control, its sessions. */
  async refreshHost(hostKey: string): Promise<RemoteHostSnapshot | null> {
    const client = await this.clientFor(hostKey)
    const known = this.known.get(hostKey)
    if (!client || !known) {
      return null
    }
    const negotiation = await client.negotiate()
    const { state, detail } = remoteHostState(negotiation)
    let counts: RemoteHostCounts | null = null
    let observeDetail: string | undefined
    if (state === 'ready') {
      const observed = await client.observe({})
      if (observed.status === 'ok') {
        this.directory.noteConnection(hostKey, observed.host)
        this.directory.noteObservation(observed)
        counts = remoteHostCounts(observed.sessions)
      } else {
        observeDetail = observed.refusal.message
      }
    }
    const snapshot: RemoteHostSnapshot = {
      hostKey,
      kind: known.snapshot.kind,
      state: observeDetail && state === 'ready' ? 'unreachable' : state,
      ...(detail || observeDetail ? { detail: observeDetail ?? detail } : {}),
      ...(negotiation?.peer ? { hostId: negotiation.peer.hostId } : {}),
      capabilities: [...(negotiation?.agreed ?? [])],
      checkedAt: this.deps.now(),
      counts
    }
    known.snapshot = snapshot
    return snapshot
  }

  /** Refreshes the stale ones among `hostKeys`, a few at a time; one refresh runs at once. */
  refresh(hostKeys: readonly string[]): Promise<void> {
    if (this.refreshing) {
      return this.refreshing
    }
    const now = this.deps.now()
    const due = [...new Set(hostKeys)].filter((key) => {
      const checkedAt = this.known.get(key)?.snapshot.checkedAt ?? null
      return checkedAt === null || now - checkedAt >= REMOTE_HOST_REFRESH_MS
    })
    const run = async (): Promise<void> => {
      const queue = [...due]
      const worker = async (): Promise<void> => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          // Why caught: one host's failure must not stop the others' readings.
          await this.refreshHost(key).catch(() => null)
        }
      }
      await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, due.length) }, worker))
    }
    this.refreshing = run().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** One per remote key: its last reading, or `checking` until one exists. */
  snapshots(hostKeys: readonly string[]): RemoteHostSnapshot[] {
    return [...new Set(hostKeys)].flatMap((hostKey): RemoteHostSnapshot[] => {
      const known = this.known.get(hostKey)
      if (known) {
        return [known.snapshot]
      }
      const host = parseExecutionHostId(hostKey)
      return host && host.kind !== 'local'
        ? [
            {
              hostKey,
              kind: host.kind,
              state: 'checking',
              capabilities: [],
              checkedAt: null,
              counts: null
            }
          ]
        : []
    })
  }
}
