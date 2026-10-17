import { useEffect } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useSessionLedger } from '@/store/session-ledger-store'

export function useSessionLedgerSidebar(): number {
  const scope = useHandoffScope()
  const count = useSessionLedger((state) => state.badgeCount)
  useEffect(() => useSessionLedger.getState().start(), [scope])
  return count
}
