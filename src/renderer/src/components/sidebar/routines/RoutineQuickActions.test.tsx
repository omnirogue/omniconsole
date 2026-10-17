// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./routine-conversation-state', () => ({
  useRoutineForTab: () => ({
    automation: { name: 'Advertising review', prompt: 'Review company ads' }
  })
}))
import { RoutineQuickActions } from './RoutineQuickActions'
afterEach(cleanup)
it('offers both ad rankings and asks for a specific Yes/No proposal before changes', () => {
  const choose = vi.fn()
  render(<RoutineQuickActions tabId="tab" paneKey="pane" disabled={false} onChoose={choose} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'What are the highest probability ads we can turn on?' })
  )
  expect(choose).toHaveBeenLastCalledWith(expect.stringContaining('Do not make changes yet.'))
  fireEvent.click(
    screen.getByRole('button', { name: 'What are the lowest probability ads we can shut off?' })
  )
  expect(choose).toHaveBeenLastCalledWith(expect.stringContaining('Yes and No buttons'))
  expect(choose).toHaveBeenLastCalledWith(expect.stringContaining('Review company ads'))
})
it('does not bypass an unavailable composer', () => {
  const choose = vi.fn()
  render(<RoutineQuickActions tabId="tab" paneKey="pane" disabled onChoose={choose} />)
  fireEvent.click(screen.getAllByRole('button')[0])
  expect(choose).not.toHaveBeenCalled()
})
