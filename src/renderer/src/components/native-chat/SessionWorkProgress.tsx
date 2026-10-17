import { useState } from 'react'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionChainForRow, setSessionChainEntry } from '@/lib/session-chain-registry'
import { NextStepOutcomeStatus } from '@/components/next-step/NextStepOutcomeStatus'
import { draftFromChain } from '@/components/next-step/next-step-outcome-hydration'
import { OutcomeResumeAction } from '@/components/next-step/OutcomeResumeAction'

export function SessionWorkProgress({ session }: { session: SidebarSession }) {
  const chain = useSessionChainForRow(session.rowKey)
  const [error, setError] = useState('')
  const outcome = chain?.outcomeSet ? draftFromChain(chain).outcomes?.[0] : undefined
  if (!chain || !outcome) {
    return null
  }
  return (
    <div className="px-3 pb-2">
      <NextStepOutcomeStatus
        session={session}
        outcome={outcome}
        chain={chain}
        onChainChanged={setSessionChainEntry}
        onError={setError}
      />
      <OutcomeResumeAction chain={chain} onChanged={setSessionChainEntry} onError={setError} />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
