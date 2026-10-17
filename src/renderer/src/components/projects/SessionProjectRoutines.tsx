import React from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useNow } from '@/hooks/use-now'
import { useAppStore } from '@/store'
import { useConversationRoutines } from '@/components/sidebar/routines/use-conversation-routines'
import { routineRowCaption } from '@/components/sidebar/routines/routine-row-details'
import type { Automation } from '../../../../shared/automations-types'

const NEW_ROUTINE_CRON = '0 9 * * *'

function lastRanLabel(automation: Automation, now: number): string {
  return automation.lastRunAt
    ? translate('projects.routines.lastRan', 'Last ran {{time}}', {
        time: formatUiRelativeTime(automation.lastRunAt - now)
      })
    : translate('projects.routines.neverRan', 'Not run yet')
}

/** Routines whose runs join this project, with Run now and a New routine that files into it. */
export function SessionProjectRoutines({ folderId }: { folderId: string }): React.JSX.Element {
  const { automations, commands, open } = useConversationRoutines()
  const routines = automations.filter((automation) => automation.sessionFolder === folderId)
  const now = useNow(60_000)
  const create = () => {
    const state = useAppStore.getState()
    state.setPendingRoutineDraftSeed({ cron: NEW_ROUTINE_CRON, sessionFolder: folderId })
    state.setActiveView('automations')
  }
  return (
    <section
      aria-label={translate('projects.routines.title', 'Routines')}
      data-session-project-routines={routines.length}
      className="space-y-2"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">
          {translate('projects.routines.heading', 'Routines {{count}}', {
            count: routines.length
          })}
        </h2>
        <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={create}>
          {translate('projects.routines.new', 'New routine')}
        </Button>
      </div>
      {routines.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
          {translate(
            'projects.routines.empty',
            'No routines yet. A routine made here runs on its schedule with the project’s context and files its runs here.'
          )}
        </p>
      ) : (
        <ul className="space-y-px">
          {routines.map((automation) => (
            <li
              key={automation.id}
              data-session-project-routine={automation.id}
              className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs"
            >
              <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                className="min-w-0 truncate text-left font-medium hover:underline"
                onClick={() => open(automation)}
              >
                {automation.name}
              </button>
              <span className="min-w-0 truncate text-muted-foreground">
                {[...routineRowCaption(automation, now), lastRanLabel(automation, now)].join(' · ')}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => void commands.runNow(automation)}
              >
                {translate('routines.runNow', 'Run now')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
