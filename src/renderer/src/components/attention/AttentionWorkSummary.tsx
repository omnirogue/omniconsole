import React from 'react'
import { Button } from '@/components/ui/button'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  describeWorkGap,
  type WorkLens
} from '@/components/task-page/backoffice/backoffice-work-labels'
import { useNeedsYouCounts } from '@/components/task-page/backoffice/backoffice-needs-you-counts'
import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

function openTasks(scope: string, lens?: WorkLens): void {
  if (lens) {
    useBackofficeWorkFocus.getState().focus({ scope, lens })
  }
  useAppStore.getState().openTaskPage({ taskSource: 'backoffice' })
}

/**
 * "N need you" is the one number the Work badge and the Work home show too (panes waiting
 * on the person plus console rows); "N waiting" is console-only, a pane never waits. One
 * store, one formula, so the surfaces never disagree. Loads on open, never on a timer.
 *
 * Why the two buttons land in different places: only Work shows panes AND console rows, so
 * that is where "N need you" opens; "N waiting" is console work, so it opens the Tasks lens.
 */
export function AttentionWorkSummary(): React.JSX.Element {
  const scope = useHandoffScope()
  const { views, counts, loading } = useNeedsYouCounts(scope, true)
  const unavailable =
    views.gaps.includes('todo-unavailable') && views.gaps.includes('received-unavailable')
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5" data-attention-work-summary="">
      {loading && views.all.length === 0 ? (
        <span className="px-1 text-[11px] text-muted-foreground">
          {translate('backofficeWork.summaryLoading', 'Loading work…')}
        </span>
      ) : unavailable ? (
        <span className="px-1 text-[11px] text-muted-foreground">
          {translate('backofficeWork.summaryUnavailable', 'Work feed unavailable')}
        </span>
      ) : (
        <>
          <Button
            variant="ghost"
            size="xs"
            data-work-count="needs-you"
            onClick={() => useAppStore.getState().openWorkHomePage()}
          >
            {translate('backofficeWork.summaryNeedsYou', '{{count}} need you', {
              count: counts.total
            })}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            data-work-count="waiting"
            onClick={() => openTasks(scope, 'waiting')}
          >
            {translate('backofficeWork.summaryWaiting', '{{count}} waiting', {
              count: counts.waiting
            })}
          </Button>
          {views.gaps.length > 0 ? (
            <span
              className="px-1 text-[11px] text-muted-foreground"
              title={views.gaps.map(describeWorkGap).join('\n')}
            >
              {translate('backofficeWork.summaryPartial', 'partial')}
            </span>
          ) : null}
        </>
      )}
      <Button variant="outline" size="xs" onClick={() => openTasks(scope)}>
        {translate('backofficeWork.openTasks', 'Open Tasks')}
      </Button>
    </div>
  )
}
