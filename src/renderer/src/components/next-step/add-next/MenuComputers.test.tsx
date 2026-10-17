// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MenuComputers } from './MenuComputers'

const placement = vi.hoisted(() => ({ find: vi.fn<(...args: unknown[]) => string | null>() }))
vi.mock('../next-step-placement', () => ({ findNextStepWorkspaceId: placement.find }))
const state = {
  sshTargetLabels: new Map([
    ['server', 'Build server'],
    ['shop', 'Customer shop']
  ]),
  sshConnectionStates: new Map([['server', { status: 'connected' }]]),
  runtimeEnvironments: [{ id: 'env', name: 'Paired laptop' }],
  runtimeStatusByEnvironmentId: new Map([['env', { status: 'online' }]])
}
vi.mock('@/store', () => ({
  useAppStore: (select: (value: unknown) => unknown) => select(state)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { count?: number }) =>
    fallback.replace('{{count}}', String(options?.count ?? ''))
}))

afterEach(cleanup)

describe('🚀 computers', () => {
  // Why: a chain cannot follow a session onto a paired host; the launch there returns no tab.
  it('offers this computer and the SSH connections that hold a workspace of the repo, never a paired host', () => {
    placement.find.mockImplementation((_state, _source, host) =>
      host === 'ssh:server' ? 'wt' : null
    )
    render(<MenuComputers selected={null} sourceWorktreeId="source" onChoose={vi.fn()} />)
    expect(screen.getByRole('menuitem', { name: /Build server/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Customer shop/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Paired laptop/ })).toBeNull()
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    expect(screen.getByText(/1 more computers have no workspace/)).toBeTruthy()
  })
  it('lists only this computer when the conversation has no workspace to match', () => {
    render(<MenuComputers selected={null} onChoose={vi.fn()} />)
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByText(/2 more computers have no workspace/)).toBeTruthy()
  })
})
