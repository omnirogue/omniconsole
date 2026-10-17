// @vitest-environment happy-dom
/**
 * Handoff and review due dates on the Calendar grid: each on its local due day, labelled
 * "Handoff due" / "Review due" with the other person, finished ones only when finished work is
 * shown, and a click hands the thread to the page to open as the Work list does.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ConsoleCalendarFeed } from '../../../../shared/console-calendar-contract'
import { upNextDueAt } from '../../../../shared/up-next-person-due'
import { CalendarGrid } from './CalendarGrid'
import { calendarDays, dayDate, timeLabel } from './calendar-dates'
import { calendarHandoffDues, type CalendarHandoffDue } from './calendar-handoffs'
import { handoffReads } from './calendar-handoffs.test-fixture'

afterEach(cleanup)

const feed: ConsoleCalendarFeed = {
  entries: [],
  tasks: [],
  projects: [],
  projects_available: true,
  agent: [],
  overlay_errors: [],
  generated_at: '2026-09-18T12:00:00Z'
}
const names = new Map([
  ['emp_iris', 'Iris Allen'],
  ['emp_sal', 'Jordan Taylor']
])
const noop = () => undefined

function grid(options: { showFinished?: boolean; onHandoff?: (due: CalendarHandoffDue) => void }) {
  return (
    <TooltipProvider>
      <CalendarGrid
        feed={feed}
        days={calendarDays('2026-09-20', 'week')}
        anchor="2026-09-20"
        view="week"
        showFinished={options.showFinished ?? false}
        names={names}
        onDay={noop}
        onCreate={noop}
        onEntry={noop}
        onTask={noop}
        onProject={noop}
        handoffs={calendarHandoffDues(handoffReads())}
        onHandoff={options.onHandoff ?? noop}
      />
    </TooltipProvider>
  )
}

/** One day's cell, found by the full date it is labelled with. */
const day = (key: string) =>
  screen.getByLabelText(dayDate(key).toLocaleDateString(undefined, { dateStyle: 'full' }))

describe('handoff due dates on the calendar', () => {
  it('shows a sent handoff and a received review on their due days, with the other person', () => {
    render(grid({}))
    const monday = within(day('2026-09-21'))
    expect(monday.getByText('Ship the receipts')).toBeTruthy()
    expect(monday.getByText('Handoff due · to Iris Allen')).toBeTruthy()
    const tuesday = within(day('2026-09-22'))
    expect(tuesday.getByText('Check the signing')).toBeTruthy()
    // Why: the matcher collapses the narrow no-break space some locales put before "PM".
    const time = timeLabel(upNextDueAt('2026-09-22', '15:30')!).replace(/\s+/g, ' ')
    expect(tuesday.getByText(`Review due · from Jordan Taylor · ${time}`)).toBeTruthy()
    expect(within(day('2026-09-20')).queryByText('Ship the receipts')).toBeNull()
  })

  it('shows a finished handoff only when finished work is shown', () => {
    const mounted = render(grid({}))
    expect(within(day('2026-09-23')).queryByText('Old handoff')).toBeNull()
    mounted.rerender(grid({ showFinished: true }))
    expect(within(day('2026-09-23')).getByText('Old handoff')).toBeTruthy()
    expect(within(day('2026-09-23')).getByText('Handoff due · from Jordan Taylor')).toBeTruthy()
  })

  it('hands the clicked thread to the page to open', () => {
    const onHandoff = vi.fn()
    render(grid({ onHandoff }))
    fireEvent.click(within(day('2026-09-21')).getByText('Ship the receipts').closest('button')!)
    expect(onHandoff).toHaveBeenCalledTimes(1)
    expect(onHandoff.mock.calls[0]![0]).toMatchObject({
      key: 'handoff:hth_sent',
      direction: 'sent',
      row: { source: 'sent-handoff' }
    })
  })
})
