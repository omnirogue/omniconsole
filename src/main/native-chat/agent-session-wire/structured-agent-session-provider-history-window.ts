// Sampling the provider's own history so a restart-stranded send can be decided.
//
// Lifted out of structured-agent-session-attach-flow.ts so that file stays inside
// its line budget. Kept beside it rather than folded into the adapter: the read is
// only sound at the one point the attach flow calls it from — after the lease is
// held and before a child starts — and that ordering is the flow's to state.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export async function readProviderHistoryWindow(input: {
  adapter: StructuredAgentSessionAdapter
  identity: AgentSessionJournalIdentity
  accountHome: AgentSessionRecord['accountHome']
  ownerAlreadyAdmitted: boolean
}): Promise<ProviderHistoryWindow | null> {
  const read = input.adapter.providerHistoryWindow
  if (!read) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await read({ identity: input.identity, accountHome: input.accountHome })
  } catch {
    return null
  }
  // A lease that was already live may belong to a provider child this process
  // has not indexed yet. Preserve the safe unknown outcome in that case.
  return history && input.ownerAlreadyAdmitted ? { ...history, turnInFlight: true } : history
}
