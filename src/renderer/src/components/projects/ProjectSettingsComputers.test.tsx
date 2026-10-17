// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = {
  sshTargetLabels: new Map([['mac-studio', 'Mac Studio']]),
  runtimeEnvironments: [{ id: 'env-1', name: 'Office Mac' }]
}
vi.mock('@/store', () => ({
  useAppStore: (select: (s: typeof state) => unknown) => select(state)
}))

import { ProjectSettingsComputers } from './ProjectSettingsComputers'

afterEach(cleanup)

it('lists this computer, SSH hosts and paired computers, and toggles a paired one', () => {
  const onChange = vi.fn()
  render(<ProjectSettingsComputers mode="hosts" hosts={['local']} onChange={onChange} />)
  expect(screen.getByText('This computer')).not.toBeNull()
  expect(screen.getByText('Mac Studio')).not.toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Office Mac' }))
  expect(onChange).toHaveBeenCalledWith({ hostMode: 'hosts', hosts: ['local', 'runtime:env-1'] })
  expect(screen.getByText(/first computer here that can take them/)).not.toBeNull()
})

it('explains the order only for a named list', () => {
  render(<ProjectSettingsComputers mode="auto" hosts={[]} onChange={vi.fn()} />)
  expect(screen.queryByText(/first computer here/)).toBeNull()
})
