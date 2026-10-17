// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ enabled: true, create: vi.fn() }))
const state = {
  settings: { commandCenter: true },
  worktreesByRepo: { repo: [{ id: 'wt' }] },
  folderWorkspaces: [],
  activeWorktreeId: 'wt'
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (value: unknown) => unknown) =>
      select({ ...state, settings: { commandCenter: mocks.enabled } }),
    { getState: () => state }
  )
}))
vi.mock('@/lib/sidebar-session-context', () => ({
  sidebarSessionWorkspace: () => ({ workspaceLabel: 'Workspace' })
}))
vi.mock('@/lib/command-center-terminal-creation', () => ({
  createCommandCenterTerminal: mocks.create,
  TerminalCreationUnverifiableError: class extends Error {}
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { TerminalCreationUnverifiableError } from '@/lib/command-center-terminal-creation'
import PlainTerminalPane from './PlainTerminalPane'
beforeEach(() => {
  mocks.enabled = true
  mocks.create.mockReset()
})
afterEach(cleanup)
it('creates nothing on mount and fences a double click until the explicit request completes', async () => {
  let done: () => void = () => {}
  mocks.create.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve
      })
  )
  render(<PlainTerminalPane paneId="pane" />)
  expect(mocks.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Create terminal' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create terminal' }))
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledWith('pane', 'wt')
  done()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Create terminal' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
})
it('shows the refusal and keeps the chooser when its host is disconnected', async () => {
  mocks.create.mockRejectedValue(
    new Error('The execution computer is disconnected. No terminal was created.')
  )
  render(<PlainTerminalPane paneId="pane" />)
  fireEvent.click(screen.getByRole('button', { name: 'Create terminal' }))
  expect((await screen.findByRole('alert')).textContent).toContain('disconnected')
  expect(screen.getByLabelText('Terminal workspace')).toBeTruthy()
})
it('blocks retry after an uncertain host creation response', async () => {
  mocks.create.mockRejectedValue(new TerminalCreationUnverifiableError('Creation unverifiable'))
  render(<PlainTerminalPane paneId="pane" />)
  fireEvent.click(screen.getByRole('button', { name: 'Create terminal' }))
  await screen.findByRole('alert')
  expect(
    (screen.getByRole('button', { name: 'Create terminal' }) as HTMLButtonElement).disabled
  ).toBe(true)
})
it('does nothing with commandCenter off', () => {
  mocks.enabled = false
  expect(render(<PlainTerminalPane paneId="pane" />).container.innerHTML).toBe('')
  expect(mocks.create).not.toHaveBeenCalled()
})
