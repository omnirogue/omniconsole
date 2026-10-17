import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { sessionOutcomeConnection } from '@/lib/session-outcome-connection'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { sessionOutcomePlanState } from '../../../../shared/session-outcome-plan-state'

export function ViewPlanButton({ chain }: { chain: SessionChain }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (sessionOutcomePlanState(chain) !== 'plan-ready') {
    return null
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async (event) => {
          event.stopPropagation()
          setBusy(true)
          setError(null)
          try {
            const connection = await sessionOutcomeConnection(chain).negotiate()
            await connection.call('workPlan.open', { id: chain.id })
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          } finally {
            setBusy(false)
          }
        }}
      >
        {translate('workPlan.view', 'View Plan')}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  )
}
