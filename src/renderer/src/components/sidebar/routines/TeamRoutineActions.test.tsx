// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TeamRoutine } from '../../../../../shared/console-team-routines-contract'
import { TeamRoutineActions } from './TeamRoutineActions'
const mocks = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn() }))
vi.mock('./team-routines-client', () => ({ teamRoutinesApi: () => mocks }))
// Exercise the action through its menu item without depending on pointer capture in happy-dom.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: React.PropsWithChildren<{ onSelect: () => void; disabled: boolean }>) => (
    <button role="menuitem" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  )
}))
beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)
it.each(['collaborator', null] as const)(
  'omits the toggle entirely for viewer_role %s',
  (viewer_role) => {
    render(
      <TeamRoutineActions
        routine={{
          id: 'rtn_demo',
          status: 'disabled',
          viewer_role,
          members: []
        }}
        name="Demo"
        onUpdated={vi.fn()}
      />
    )
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  }
)
it.each([
  ['disabled', 'Turn on', 'enable'],
  ['active', 'Turn off', 'disable']
] as const)(
  'offers the owner the opposite action for %s and updates the row',
  async (status, label, method) => {
    const routine: TeamRoutine = {
      id: 'rtn_demo',
      status,
      viewer_role: 'owner',
      members: []
    }
    const updated = {
      ...routine,
      status: status === 'disabled' ? 'active' : 'disabled'
    }
    mocks[method].mockResolvedValue({ ok: true, data: updated })
    const onUpdated = vi.fn()
    render(<TeamRoutineActions routine={routine} name="Demo" onUpdated={onUpdated} />)
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated))
    expect(mocks[method]).toHaveBeenCalledWith({ id: 'rtn_demo' })
  }
)
it('keeps the hub failure visible without patching status', async () => {
  mocks.enable.mockResolvedValue({
    ok: false,
    error: { code: 'not_ready', message: 'Proof of life required' }
  })
  const onUpdated = vi.fn()
  render(
    <TeamRoutineActions
      routine={{
        id: 'rtn_demo',
        status: 'disabled',
        viewer_role: 'owner',
        members: []
      }}
      name="Demo"
      onUpdated={onUpdated}
    />
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Turn on' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Proof of life required')
  expect(onUpdated).not.toHaveBeenCalled()
})
