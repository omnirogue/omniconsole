// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EmployeePeopleList } from './EmployeePeopleList'
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({
    people: {
      phase: 'ready',
      value: [
        { id: 'emp_uma', name: 'Uma' },
        { id: 'emp_sal', name: 'Sal' }
      ]
    },
    reload: vi.fn()
  })
}))
afterEach(cleanup)
it('shows employees without sessions and never claims unverified online status', () => {
  render(<EmployeePeopleList />)
  expect(screen.getByText('Uma')).toBeTruthy()
  expect(screen.getByText('Sal')).toBeTruthy()
  expect(screen.getAllByText('Presence unavailable')).toHaveLength(2)
  expect(screen.queryByText('Online')).toBeNull()
})
