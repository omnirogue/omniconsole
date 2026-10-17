// Read-only derivations over loaded session records.
//
// Lifted out of agent-session-record-store.ts so that file stays inside its line
// budget. Nothing here touches the transaction queue: these answer questions about
// records already in memory, which is why they need no store instance.

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { classifyObservedAgentSessionSpawnToken } from '../../shared/agent-session-lease-adjudication'

/** Spawn tokens observed on the host with no matching lease. Stop them; never adopt them. */
export function listOrphanAgentSessionSpawnTokens(
  records: readonly AgentSessionRecord[],
  observedTokens: readonly string[]
): string[] {
  const leases = records.map((record) => record.lease)
  return observedTokens.filter(
    (spawnToken) => classifyObservedAgentSessionSpawnToken({ spawnToken, leases }) === 'orphan'
  )
}
