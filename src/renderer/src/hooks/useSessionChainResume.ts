import { useSessionFinishActions } from '@/lib/session-finish-actions'
import { useEffect } from 'react'
import { watchCommittedSessionOutcomes } from '@/lib/session-outcome-refresh'
import { loadSessionChains } from '@/lib/session-chain-runner'

/**
 * Resume persisted session chains once per app session. The runner itself waits for
 * the workspace session to be restored, so the hook only has to fire once.
 */
export function useSessionChainResume(): void {
  useSessionFinishActions()
  useEffect(() => {
    const stopOutcomeObservation = watchCommittedSessionOutcomes()
    void loadSessionChains()
    return stopOutcomeObservation
  }, [])
}
