import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { RoutineConversationActions } from './RoutineConversationActions'
import { useRoutineForTab } from './routine-conversation-state'
import { routineScheduleLabel } from './routine-schedule-label'

export function RoutineConversationHeader({ tabId, paneKey }: { tabId: string; paneKey: string }) {
  const routine = useRoutineForTab(tabId, paneKey)
  if (!routine) {
    return null
  }
  const { automation } = routine
  return (
    <>
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2"
        data-routine-conversation
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{automation.name}</p>
          <p className="text-xs text-muted-foreground">{routineScheduleLabel(automation.rrule)}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const state = useAppStore.getState()
            state.setSelectedAutomationId(automation.id)
            state.openAutomationsPage()
          }}
        >
          {translate('routines.settings', 'Routine settings')}
        </Button>
      </div>
      <RoutineConversationActions routine={routine} />
    </>
  )
}
