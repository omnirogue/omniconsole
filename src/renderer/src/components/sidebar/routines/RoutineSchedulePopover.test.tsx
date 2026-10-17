// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setSelectedAutomationId: vi.fn(), openAutomationsPage: vi.fn() }) }
}))
// Why: Radix Select mounts its options in a portal only once opened; a native select keeps every
// option in the document so the test can pick one with a change event.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select
      value={value}
      aria-label={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))
import { RoutineSchedulePopover } from './RoutineSchedulePopover'

const automation = {
  id: 'a',
  name: 'Ads check',
  prompt: 'Check ads',
  rrule: '*/30 * * * *',
  enabled: true
} as Automation

const onSave = vi.fn()

function renderPopover(routine: Automation = automation) {
  return render(
    <RoutineSchedulePopover automation={routine} onSave={onSave}>
      <button type="button">Schedule</button>
    </RoutineSchedulePopover>
  )
}

const selectByValue = (value: string) => screen.getByRole('combobox', { name: value })

beforeEach(() => {
  onSave.mockReset()
  onSave.mockResolvedValue(true)
})
afterEach(cleanup)

it('composes an office-hours window from the controls and saves it as cron', async () => {
  const user = userEvent.setup()
  renderPopover()
  await user.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(screen.getByText('When it runs')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  for (const day of ['Sunday', 'Saturday']) {
    await user.click(screen.getByRole('button', { name: day }))
  }
  fireEvent.change(selectByValue('0'), { target: { value: '9' } })
  fireEvent.change(selectByValue('23'), { target: { value: '17' } })
  expect(screen.getByText('Every 30 min · Mon–Fri · 09:00–17:59')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith({ rrule: '*/30 9-17 * * 1-5' })
  await waitFor(() => expect(screen.queryByText('When it runs')).toBeNull())
})

it('reads an existing window back into the controls and pauses through the switch', async () => {
  const user = userEvent.setup()
  renderPopover({ ...automation, rrule: '*/30 9-17 * * 1-5' })
  await user.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(selectByValue('interval:30')).toBeTruthy()
  expect(selectByValue('9')).toBeTruthy()
  expect(selectByValue('17')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Sunday' }).getAttribute('aria-pressed')).toBe('false')
  await user.click(screen.getByRole('switch', { name: 'Active' }))
  expect(screen.getByText('Paused')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith({ enabled: false })
})

it('switches to a weekday clock time and refuses a window with no days', async () => {
  const user = userEvent.setup()
  renderPopover()
  await user.click(screen.getByRole('button', { name: 'Schedule' }))
  fireEvent.change(selectByValue('interval:30'), { target: { value: 'weekdays' } })
  expect(screen.getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Sunday' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.queryByText('Allowed hours')).toBeNull()
  expect(screen.getByText(/^Weekdays at /)).toBeTruthy()
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await user.click(screen.getByRole('button', { name: day }))
  }
  expect(screen.getByRole('alert').textContent).toBe('Choose at least one day.')
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Wednesday' }))
  expect(screen.queryByRole('alert')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith({ rrule: '0 9 * * 3' })
})

it('shows a custom cron read-only and still allows pausing', async () => {
  const user = userEvent.setup()
  renderPopover({ ...automation, rrule: '0 9 1 * *' })
  await user.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(screen.getByText('Custom cron — edit in Routine settings')).toBeTruthy()
  expect(screen.getByText('0 9 1 * *', { selector: 'code' })).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
  await user.click(screen.getByRole('switch', { name: 'Active' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith({ enabled: false })
})
