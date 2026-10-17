import { EmployeePeopleList } from './EmployeePeopleList'
import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openSessionLedgerConsole } from '@/lib/session-ledger-console'
import { useSessionLedger } from '@/store/session-ledger-store'
import { ledgerSectionRows } from './session-ledger-rows'
import { TeamSessionSection } from './TeamSessionSection'

export default function TeamSessionsSidebar({
  store = useSessionLedger
}: {
  store?: typeof useSessionLedger
}) {
  const live = store((state) => state.live)
  const today = store((state) => state.today)
  const overflow = live?.ok ? live.overflow : today?.ok ? today.overflow : 0
  const hasRows = ledgerSectionRows(live, true).length + ledgerSectionRows(today, false).length > 0
  const refreshing = store((state) => state.refreshing)
  const refresh = store((state) => state.refresh)
  useEffect(() => {
    store.getState().setTeamTabMounted(true)
    return () => store.getState().setTeamTabMounted(false)
  }, [store])
  return (
    <div className="min-h-0 flex-1 overflow-y-auto worktree-sidebar-scrollbar">
      <EmployeePeopleList />
      <div className="flex items-center justify-end gap-1 px-2 py-1">
        <Button variant="ghost" size="xs" onClick={() => openSessionLedgerConsole()}>
          {translate('sessionLedger.history', 'See history')}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translate('sessionLedger.refresh', 'Refresh team sessions')}
          title={translate('sessionLedger.refresh', 'Refresh team sessions')}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <TeamSessionSection
        title={translate('sessionLedger.liveNow', 'Live now')}
        result={live}
        live
        retry={() => void refresh()}
      />
      <TeamSessionSection
        title={translate('sessionLedger.today', 'Today')}
        result={today}
        live={false}
        retry={() => void refresh()}
      />
      {overflow > 0 && hasRows ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          {translate('sessionLedger.overflow', '+{{count}} more in the console', {
            count: overflow
          })}
        </p>
      ) : null}
    </div>
  )
}
