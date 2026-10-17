// Session parity (step 8) reads main takes from its window: the UNFILTERED canonical population
// `omni session list --json` exports beside its filtered rows (C5), and each paired owner's ledger
// state `omni session hosts` shows (G2). Read-only and tolerant: no window (a headless relaunch),
// or an older one that does not know the request, answers nothing — never zeros — and owner states
// then come from this computer's durable receiver snapshots, which can only say "as of".

import type { RemoteConversationLedgerSnapshot } from '../../shared/remote-conversation-ledger-snapshot'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { RemoteHostSnapshot } from '../../shared/session-hosts-status'
import type { SessionOwnerLedgerState, SessionParityPopulation } from '../../shared/session-parity'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { getRemoteConversationLedgerStore } from '../session-host-remote/remote-conversation-ledger-runtime'

type Runtime = Pick<OrcaRuntimeService, 'requestSessionFolders'>

function isParityPopulation(value: unknown): value is SessionParityPopulation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const population = value as Partial<SessionParityPopulation>
  return Array.isArray(population.rows) && Array.isArray(population.countsByHost)
}

/** The window's parity population, or null: no window, still restoring, or an older window. */
export async function readSessionParityPopulation(
  runtime: Runtime
): Promise<SessionParityPopulation | null> {
  try {
    const result = await runtime.requestSessionFolders({ kind: 'readParityPopulation' })
    return isParityPopulation(result) ? result : null
  } catch {
    return null
  }
}

/** A durable receiver snapshot says nothing live of its owner: as of its newest evidence. */
export function snapshotOwnerLedgerState(
  snapshot: RemoteConversationLedgerSnapshot
): SessionOwnerLedgerState {
  return {
    hostId: `runtime:${snapshot.environmentId}`,
    generation: snapshot.set?.generation ?? null,
    revision: snapshot.set?.revision ?? null,
    source: snapshot.set?.source ?? null,
    state: 'stale',
    asOf: snapshot.asOf ?? snapshot.savedAt
  }
}

/** Every paired owner's ledger state: the window's word, else this computer's kept snapshots. */
export async function readOwnerLedgerStates(runtime: Runtime): Promise<SessionOwnerLedgerState[]> {
  try {
    const result = await runtime.requestSessionFolders({ kind: 'readOwnerLedgers' })
    if (Array.isArray(result)) {
      return result as SessionOwnerLedgerState[]
    }
  } catch {
    // Why fall through: with no window, what this computer kept on disk is all it knows.
  }
  const snapshots = await getRemoteConversationLedgerStore()
    .snapshots()
    .catch(() => [])
  return snapshots.filter((snapshot) => snapshot.set).map(snapshotOwnerLedgerState)
}

function environmentOf(hostId: string): string | null {
  const host = parseExecutionHostId(hostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}

/** Each paired computer's line with what this computer knows of its ledger (G2). */
export function withOwnerLedgers(
  hosts: readonly RemoteHostSnapshot[],
  ledgers: readonly SessionOwnerLedgerState[]
): RemoteHostSnapshot[] {
  const byEnvironment = new Map(
    ledgers.flatMap((ledger) => {
      const environmentId = environmentOf(ledger.hostId)
      return environmentId ? [[environmentId, ledger] as const] : []
    })
  )
  return hosts.map((host) => {
    const environmentId = environmentOf(host.hostKey)
    const ledger = environmentId ? byEnvironment.get(environmentId) : undefined
    return ledger ? { ...host, ledger } : host
  })
}
