// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode, MouseEvent } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeComputerMenu } from './RuntimeComputerMenu'
import type { SidebarHostOption } from '../sidebar-host-options'
vi.mock('@/components/host-resources/host-resource-poller', () => ({
  useHostResourceReadings: () => new Map(),
  useHostResourceClock: () => 0
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect
    }: {
      children: ReactNode
      disabled: boolean
      onSelect: (event: MouseEvent) => void
    }) => (
      <button disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    )
  }
})
afterEach(cleanup)
const hosts: SidebarHostOption[] = [
  { id: 'local', kind: 'local', label: 'This Mac', detail: '', health: 'local', presence: 'local' },
  {
    id: 'runtime:worker',
    kind: 'runtime',
    label: 'Worker',
    detail: '',
    health: 'available',
    presence: 'configured'
  },
  {
    id: 'ssh:server',
    kind: 'ssh',
    label: 'SSH server',
    detail: '',
    health: 'available',
    presence: 'configured'
  }
]
it('chooses the runtime for viewing and launch, and keeps SSH in its own control', async () => {
  const select = vi.fn().mockResolvedValue(true)
  render(<RuntimeComputerMenu hosts={hosts} activeHostId="local" onSelectHost={select} />)
  expect(screen.queryByText('SSH server')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Worker/ }))
  await waitFor(() => expect(select).toHaveBeenCalledWith('runtime:worker'))
})
it('blocks overlapping switches until the current computer selection settles', async () => {
  let finish!: (value: boolean) => void
  const select = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
  )
  render(<RuntimeComputerMenu hosts={hosts} activeHostId="local" onSelectHost={select} />)
  fireEvent.click(screen.getByRole('button', { name: /Worker/ }))
  expect(screen.getByRole('button', { name: /This Mac.*Capacity/ })).toBeDisabled()
  finish(false)
  await waitFor(() => expect(screen.getByRole('button', { name: /Worker/ })).not.toBeDisabled())
})
