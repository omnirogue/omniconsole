// Session parity (step 8) in group headings: the headline counts the rows their owners list, while
// rows listed only here — nothing current vouches for them — read apart as "+N only here (can't
// verify)", and captures an owner holds without listing (G1) as "+N held by owner". The sidebar's
// counted rows are classified once per change (from usePublishSidebarCounts) and shared here, so a
// heading never rebuilds this computer's own ledger rule itself.

import { useLayoutEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { classifySessionParity } from '@/lib/session-parity-classification'
import { sessionParityInputs } from '@/lib/session-parity-population'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  isSessionParityOnlyHere,
  type SessionParityFields
} from '../../../../../shared/session-parity'

type GroupParityState = {
  byRowKey: ReadonlyMap<string, Pick<SessionParityFields, 'bucket' | 'verification'>>
}

export const useSessionGroupParity = create<GroupParityState>(() => ({ byRowKey: new Map() }))

export type SessionGroupParityCounts = { onlyHere: number; held: number }

export function sessionGroupParityCounts(
  byRowKey: GroupParityState['byRowKey'],
  rows: readonly { session: Pick<SidebarSession, 'rowKey'> }[]
): SessionGroupParityCounts {
  let onlyHere = 0
  let held = 0
  for (const row of rows) {
    const fields = byRowKey.get(row.session.rowKey)
    if (fields && isSessionParityOnlyHere(fields)) {
      onlyHere += 1
    } else if (fields?.bucket === 'heldByOwner') {
      held += 1
    }
  }
  return { onlyHere, held }
}

/** How many of a group's rows read apart from its headline. */
export function useSessionGroupParityCounts(
  rows: readonly { session: Pick<SidebarSession, 'rowKey'> }[]
): SessionGroupParityCounts {
  return useSessionGroupParity(
    useShallow((state) => sessionGroupParityCounts(state.byRowKey, rows))
  )
}

/** Classifies the rows the sidebar counted whenever they, or what their owners say, change. */
export function usePublishSessionGroupParity(countedSessions: readonly SidebarSession[]): void {
  const owners = useAppStore((state) => state.mirroredConversationOwnersByEnvironment)
  const ledgerBuckets = useAppStore((state) => state.mirroredConversationLedgerByOwner)
  const workflowBuckets = useAppStore((state) => state.mirroredWorkflowRecordsByOwner)
  const byRowKey = useMemo(() => {
    // Why guarded: a heading's split is presentation; a failure reading this window's own ledger
    // rule must never take the list down — every heading then shows its plain total.
    try {
      const inputs = {
        ...sessionParityInputs(useAppStore.getState()),
        owners: owners ?? {},
        ledgerBuckets: ledgerBuckets ?? {},
        workflowBuckets: workflowBuckets ?? {}
      }
      return new Map(
        countedSessions.map((session) => [session.rowKey, classifySessionParity(session, inputs)])
      )
    } catch {
      return new Map()
    }
  }, [countedSessions, owners, ledgerBuckets, workflowBuckets])
  // Why a layout effect: headings show the split in the same paint as the rows.
  useLayoutEffect(() => {
    useSessionGroupParity.setState({ byRowKey })
  }, [byRowKey])
}
