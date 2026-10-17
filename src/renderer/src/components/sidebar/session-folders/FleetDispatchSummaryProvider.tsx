import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { FleetDispatchDetailsDialog } from '@/components/next-step/FleetDispatchDetails'
import { useAppStore } from '@/store'
import {
  conversationFleetScope,
  type ConversationFleetView
} from '@/store/conversation-fleet-store'

type SummarySelection = {
  scope: string
  run: ConversationFleetView
  trigger: HTMLElement | null
}

const FleetSummaryContext = createContext<{
  openWorkflowId: string | null
  openSummary: (run: ConversationFleetView, trigger: HTMLElement | null) => void
} | null>(null)

/** The summary survives row folding, regrouping and virtual scrolling, but never an account change. */
export function FleetDispatchSummaryProvider({
  runs,
  children
}: {
  runs: readonly ConversationFleetView[]
  children: React.ReactNode
}): React.JSX.Element {
  const scope = useAppStore(() => conversationFleetScope())
  const [selection, setSelection] = useState<SummarySelection | null>(null)
  const current = selection?.scope === scope ? selection : null
  const liveRun = current
    ? runs.find((candidate) => candidate.workflowId === current.run.workflowId)
    : undefined
  const run = current ? (liveRun ?? { ...current.run, verified: false }) : null
  useEffect(() => {
    setSelection((selected) => (selected?.scope === scope ? selected : null))
  }, [scope])
  useEffect(() => {
    if (liveRun) {
      setSelection((selected) =>
        selected?.scope === scope &&
        selected.run.workflowId === liveRun.workflowId &&
        selected.run !== liveRun
          ? { ...selected, run: liveRun }
          : selected
      )
    }
  }, [liveRun, scope])
  const openSummary = useCallback(
    (run: ConversationFleetView, trigger: HTMLElement | null) => {
      setSelection({ scope, run, trigger })
    },
    [scope]
  )
  const value = useMemo(
    () => ({ openWorkflowId: current?.run.workflowId ?? null, openSummary }),
    [current?.run.workflowId, openSummary]
  )
  return (
    <FleetSummaryContext.Provider value={value}>
      {children}
      {run && current ? (
        <FleetDispatchDetailsDialog
          key={`${current.scope}:${run.workflowId}`}
          run={run}
          open
          onOpenChange={(open) => {
            if (!open) {
              setSelection(null)
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const focused = document.activeElement
            const leavingPanel =
              focused === document.body ||
              !focused?.isConnected ||
              (event.target instanceof HTMLElement && event.target.contains(focused))
            if (
              leavingPanel &&
              current.scope === conversationFleetScope() &&
              current.trigger?.isConnected
            ) {
              current.trigger.focus()
            }
          }}
        />
      ) : null}
    </FleetSummaryContext.Provider>
  )
}

export function useFleetDispatchSummary(): NonNullable<
  React.ContextType<typeof FleetSummaryContext>
> {
  const context = useContext(FleetSummaryContext)
  if (!context) {
    throw new Error('Fleet rows require FleetDispatchSummaryProvider.')
  }
  return context
}
