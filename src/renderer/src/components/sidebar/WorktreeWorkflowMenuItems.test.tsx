// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeWorkflowMenuItems } from './WorktreeWorkflowMenuItems'

const mocks = vi.hoisted(() => ({ openBuildReview: vi.fn(), openCanvas: vi.fn() }))
vi.mock('@/lib/build-review-entry', () => ({ openBuildReview: mocks.openBuildReview }))
vi.mock('@/lib/local-run-navigation', () => ({ openLocalRunCanvasForWorkspace: mocks.openCanvas }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: (props: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={props.onSelect}>
      {props.children}
    </button>
  )
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorktreeWorkflowMenuItems', () => {
  it('opens Build + Review through the one entry for the row it was chosen on', () => {
    render(
      <WorktreeWorkflowMenuItems
        worktree={{ id: 'repo::wt-1', path: '/path/to/wt-1' }}
        disabled={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Build \+ Review/ }))
    expect(mocks.openBuildReview).toHaveBeenCalledWith('repo::wt-1')
    fireEvent.click(screen.getByRole('button', { name: /Run a graph/ }))
    expect(mocks.openCanvas).toHaveBeenCalledWith('/path/to/wt-1')
  })
})
