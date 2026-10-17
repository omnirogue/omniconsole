// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TaskGoalField } from './TaskGoalField'

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children
  }: {
    value: string
    disabled: boolean
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select
      aria-label="Goal"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const company = vi.fn()
const active = {
  id: 'cgl_reliability',
  title: 'Reliability',
  status: 'active',
  org_unit_id: 'org_dev'
}
const answer = (companyId: string, items = [active]) => ({
  ok: true,
  data: { company_id: companyId, goals: { available: true, items } }
})

beforeEach(() => {
  company.mockReset()
  window.api = { consoleCompanies: { company } } as never
})
afterEach(cleanup)

it('offers only active goals in the chosen company and department and keeps the explicit choice', async () => {
  company.mockResolvedValue(
    answer('co_rogue', [
      active,
      { ...active, id: 'cgl_paused', title: 'Paused', status: 'paused' },
      { ...active, id: 'cgl_archived', title: 'Archived', status: 'archived' },
      { ...active, id: 'cgl_sales', title: 'Sales', org_unit_id: 'org_sales' }
    ])
  )
  const onChange = vi.fn()
  render(<TaskGoalField companyId="co_rogue" unitId="org_dev" goalId="" onChange={onChange} />)
  await screen.findByRole('option', { name: 'Reliability' })
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'None',
    'Reliability'
  ])
  fireEvent.change(screen.getByRole('combobox'), { target: { value: active.id } })
  expect(onChange).toHaveBeenCalledWith(active.id)
  expect(company).toHaveBeenCalledWith({ companyId: 'co_rogue' })
})

it('discards a late response after changing the filing scope', async () => {
  let finish!: (value: unknown) => void
  company
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue(answer('co_os', [{ ...active, id: 'cgl_os', title: 'OS reliability' }]))
  const view = render(
    <TaskGoalField key="a" companyId="co_rogue" unitId="org_dev" goalId="" onChange={vi.fn()} />
  )
  await waitFor(() => expect(company).toHaveBeenCalledTimes(1))
  view.rerender(
    <TaskGoalField key="b" companyId="co_os" unitId="org_dev" goalId="" onChange={vi.fn()} />
  )
  await screen.findByRole('option', { name: 'OS reliability' })
  finish(answer('co_rogue'))
  await waitFor(() =>
    expect(screen.queryByRole('option', { name: /^Reliability$/ })).toBeNull()
  )
})

it('lets the person retry a failed goal read without changing filing', async () => {
  company
    .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'Offline' } })
    .mockResolvedValueOnce(answer('co_rogue'))
  render(<TaskGoalField companyId="co_rogue" unitId="org_dev" goalId="" onChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reload goals' }))
  await screen.findByRole('option', { name: 'Reliability' })
  expect(screen.queryByRole('alert')).toBeNull()
})
