// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { WorkflowContextLocalSearch } from './WorkflowContextLocalSearch'

const listing = vi.hoisted(() => ({
  state: { files: [], loading: false, loadError: null } as RuntimeFileListState
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string) => english
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ getKnownWorktreeById: () => ({ path: '/work', displayName: 'Work' }) })
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => listing.state
}))
vi.mock('./WorkflowContextSearchSelect', () => ({
  WorkflowContextSearchSelect: () => null
}))
afterEach(cleanup)

function search(state: RuntimeFileListState): void {
  listing.state = state
  render(
    <WorkflowContextLocalSearch
      worktreeId="wt-1"
      roots={[]}
      chosen={new Set()}
      onToggle={vi.fn()}
      onAdd={vi.fn()}
    />
  )
  fireEvent.change(screen.getByLabelText('Search files and folders'), {
    target: { value: 'readme' }
  })
}

describe('WorkflowContextLocalSearch', () => {
  it('adds the selected workspace rather than only changing where files are searched', () => {
    const onToggle = vi.fn()
    render(
      <WorkflowContextLocalSearch
        worktreeId="wt-1"
        roots={[]}
        chosen={new Set()}
        onToggle={onToggle}
        onAdd={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    expect(onToggle).toHaveBeenCalledWith({ kind: 'path', path: '/work' })
  })

  it('shows the removal action for a workspace already selected', () => {
    render(
      <WorkflowContextLocalSearch
        worktreeId="wt-1"
        roots={[]}
        chosen={new Set(['path:/work'])}
        onToggle={vi.fn()}
        onAdd={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Remove workspace' })).toBeEnabled()
  })

  it('says the folder could not be listed when the listing failed, not that nothing matches', () => {
    search({ files: [], loading: false, loadError: 'rg exited with code 2' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't list files in this folder. Choose a project folder, or use Add files."
    )
    expect(screen.queryByText('Nothing matches.')).toBeNull()
  })

  it('still says nothing matches for an empty result', () => {
    search({ files: ['src/index.ts'], loading: false, loadError: null })
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows searching while the listing loads', () => {
    search({ files: [], loading: true, loadError: null })
    expect(screen.getByText('Searching…')).toBeInTheDocument()
  })
})
