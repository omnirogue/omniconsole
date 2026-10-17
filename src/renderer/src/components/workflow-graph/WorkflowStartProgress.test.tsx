// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkflowStartProgress } from './WorkflowStartProgress'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('shows elapsed preparation time and clears it when admission finishes', () => {
  vi.useFakeTimers()
  const { rerender } = render(<WorkflowStartProgress active />)
  expect(screen.queryByRole('status')).toBeNull()
  act(() => {
    vi.advanceTimersByTime(12_000)
  })
  expect(screen.getByRole('status')).toHaveTextContent(
    'Preparing sources and checking run requirements…'
  )
  expect(screen.getByText('12s')).toBeVisible()
  rerender(<WorkflowStartProgress active={false} />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})
