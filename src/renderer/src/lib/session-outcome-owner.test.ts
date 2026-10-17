import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from './sidebar-sessions'
import { outcomeRuntimeTarget } from './session-outcome-owner'
import { SESSION_OUTCOME_RELAY_REFUSAL } from '../../../shared/session-outcome-routing'

const route = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./worktree-operation-route', () => ({ resolveWorktreeOperationRouteResult: route }))

beforeEach(() => route.mockReset())
describe('outcome execution owner', () => {
  it.each(['terminal', 'chat'] as const)(
    'routes a real %s session kind by its execution owner',
    (kind) => {
      const session = { kind, hostId: 'local', worktreeId: 'folder:one' } as SidebarSession
      expect(outcomeRuntimeTarget(session)).toEqual({ kind: 'local' })
      expect(outcomeRuntimeTarget({ ...session, hostId: 'runtime:peer' })).toEqual({
        kind: 'environment',
        environmentId: 'peer'
      })
      expect(route).not.toHaveBeenCalled()
    }
  )
  it('accepts explicit runtime targets and refuses a missing environment id', () => {
    expect(outcomeRuntimeTarget({ kind: 'local' })).toEqual({ kind: 'local' })
    expect(outcomeRuntimeTarget({ kind: 'environment', environmentId: 'peer' })).toEqual({
      kind: 'environment',
      environmentId: 'peer'
    })
    expect(() => outcomeRuntimeTarget({ kind: 'environment', environmentId: '' })).toThrow(
      'environment owner is missing'
    )
  })
  it('refuses relay execution without falling back to a local owner', () => {
    expect(() => outcomeRuntimeTarget({ hostId: 'ssh:server', worktreeId: 'w' })).toThrow(
      SESSION_OUTCOME_RELAY_REFUSAL
    )
    expect(route).not.toHaveBeenCalled()
  })
  it('resolves a workspace when the session has no explicit host', () => {
    route.mockReturnValue({ kind: 'resolved', route: { executionHostId: 'local' } })
    expect(outcomeRuntimeTarget({ worktreeId: 'folder:one' })).toEqual({ kind: 'local' })
    route.mockReturnValue({ kind: 'unresolved' })
    expect(() => outcomeRuntimeTarget({ worktreeId: 'missing' })).toThrow('missing or ambiguous')
  })
})
