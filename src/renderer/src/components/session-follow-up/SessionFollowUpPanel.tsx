import { useState } from 'react'
import { sessionFollowUpRefusal } from '@/lib/session-follow-up-commands'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  isLiveSessionChain,
  sessionFollowUpStep,
  type SessionChain
} from '../../../../shared/session-chain-types'
import { hasSessionFollowUpStartedDelivery } from '../../../../shared/session-follow-up-rule'
import { SessionFollowUpComposer } from './SessionFollowUpComposer'
import { SessionFollowUpReceipt } from './SessionFollowUpReceipt'
import { useSessionFollowUpFor } from './use-session-follow-up-context'

function isEditable(chain: SessionChain): boolean {
  const step = sessionFollowUpStep(chain)
  // Why: the composer rewrites the chain as one people step; a chain with agents is cancelled and re-added.
  return (
    !!step &&
    chain.steps.length === 1 &&
    (isLiveSessionChain(chain) || chain.state === 'failed') &&
    !hasSessionFollowUpStartedDelivery(step.handoff)
  )
}

/** One place both entry points open: the saved receipt, or the composer to create or edit it. */
export function SessionFollowUpPanel({ session }: { session: SidebarSession }): React.JSX.Element {
  const existing = useSessionFollowUpFor(session)
  const [composing, setComposing] = useState(false)
  const refusal = sessionFollowUpRefusal(session)
  if (refusal) {
    return <p className="text-sm text-muted-foreground">{refusal}</p>
  }
  if (existing && !composing) {
    return (
      <SessionFollowUpReceipt
        chain={existing}
        onEdit={() => setComposing(true)}
        onNew={() => setComposing(true)}
      />
    )
  }
  return (
    <SessionFollowUpComposer
      session={session}
      editing={existing && isEditable(existing) ? existing : null}
      onSaved={() => setComposing(false)}
    />
  )
}
