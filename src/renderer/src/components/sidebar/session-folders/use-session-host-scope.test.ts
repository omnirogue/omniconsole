// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { useSessionHostScope } from './use-session-host-scope'
import { useBackgroundRuntimeTerminals } from './background-runtime-terminals'

const hosts = vi.hoisted(() => ({
  options: [
    { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local', presence: 'local' },
    {
      id: 'runtime:bigmac',
      kind: 'runtime',
      label: 'BigMac',
      detail: '',
      health: 'available',
      presence: 'configured'
    }
  ]
}))
vi.mock('../use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: hosts.options, hostScopeOptions: [] })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sshTargetLabels: new Map([['runtime-ssh-vm1', 'Build VM']]),
      repos: [{ connectionId: 'dispatch' }]
    })
}))

const session = (key: string, hostId: SidebarSession['hostId']) =>
  ({ rowKey: key, sessionKey: key, hostId, paneKey: null }) as unknown as SidebarSession
const SESSIONS = [
  session('here', 'local'),
  session('there', 'runtime:bigmac'),
  session('sent', 'local')
]
// The conversation handed to the fleet leaves the list while its fleet run stands in for it.
const RUNS = [
  { rowKey: 'sent', sessionKey: 'sent', admission: 'accepted' }
] as unknown as ConversationFleetView[]

beforeEach(() => {
  useSessionSidebarView.setState({ view: emptySessionSidebarView(), loaded: true })
  useBackgroundRuntimeTerminals.setState({ terminals: [] })
})

describe('useSessionHostScope', () => {
  it('starts at Home and follows the person to any mix of host kinds', () => {
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, RUNS))
    const keys = () => result.current.sessions.map((entry) => entry.rowKey)
    expect(result.current.bar.filter).toEqual({ kinds: ['local'], hiddenHostIds: [] })
    expect(keys()).toEqual(['here'])
    expect(result.current.fleetRuns.map((run) => run.sessionKey)).toEqual(['sent'])
    expect([...result.current.bar.sessionCounts]).toEqual([
      ['local', 2],
      ['runtime:bigmac', 1]
    ])
    act(() => result.current.bar.setHostFilter({ kinds: ['local', 'runtime'], hiddenHostIds: [] }))
    expect(keys()).toEqual(['here', 'there'])
    act(() => result.current.bar.setHostFilter({ kinds: ['runtime'], hiddenHostIds: [] }))
    expect(keys()).toEqual(['there'])
    expect(result.current.fleetRuns).toEqual([])
    // The choice is kept per device, with the single host older builds can read.
    const view = useSessionSidebarView.getState().view
    expect(view.hostFilter).toEqual({ kinds: ['runtime'], hiddenHostIds: [] })
    expect(view.hostScope).toBe('runtime:bigmac')
  })

  it('offers a host that only its sessions still name, so they are never out of reach', () => {
    // An SSH-backed VM is not among the set-up hosts, but its sessions are still here.
    const vm = session('vm', 'ssh:runtime-ssh-vm1')
    const { result } = renderHook(() => useSessionHostScope([...SESSIONS, vm], []))
    expect(result.current.bar.hostOptions.map((host) => [host.id, host.label])).toEqual([
      ['local', 'Local'],
      ['runtime:bigmac', 'BigMac'],
      ['ssh:runtime-ssh-vm1', 'Build VM']
    ])
    act(() => result.current.bar.setHostFilter({ kinds: ['ssh'], hiddenHostIds: [] }))
    expect(result.current.sessions.map((entry) => entry.rowKey)).toEqual(['vm'])
  })

  it('reads the single host an older build saved', () => {
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), hostScope: 'runtime:bigmac' },
      loaded: true
    })
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, []))
    expect(result.current.bar.filter).toEqual({ kinds: ['runtime'], hiddenHostIds: [] })
    expect(result.current.sessions.map((entry) => entry.rowKey)).toEqual(['there'])
  })

  it('goes back to Home when the chosen host is no longer set up', () => {
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), hostScope: 'runtime:unpaired' },
      loaded: true
    })
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, []))
    expect(result.current.bar.filter).toEqual({ kinds: ['local'], hiddenHostIds: [] })
    expect(result.current.sessions.map((entry) => entry.rowKey)).toEqual(['here', 'sent'])
  })

  it('offers only SSH hosts with a workspace and hears asks from hosts out of view', () => {
    const ssh = (target: string) => ({
      id: `ssh:${target}`,
      kind: 'ssh',
      label: target,
      detail: '',
      health: 'available',
      presence: 'configured'
    })
    const before = hosts.options
    hosts.options = [...before, ssh('dispatch'), ssh('saved-only')]
    try {
      const asking = { ...session('ask', 'ssh:dispatch'), paneKey: 'ask' } as SidebarSession
      const snapshot = {
        cardsByPaneKey: new Map(),
        cardsByTabId: new Map(),
        attentionByPaneKey: new Map([['ask', {}]])
      } as never
      const { result } = renderHook(() => useSessionHostScope([...SESSIONS, asking], [], snapshot))
      expect(result.current.bar.hostOptions.map((host) => host.id)).toEqual([
        'local',
        'runtime:bigmac',
        'ssh:dispatch'
      ])
      expect(result.current.bar.sshWithoutWorkspace).toBe(1)
      // Home only, yet the ask on the SSH host is counted.
      expect([...result.current.bar.askCounts]).toEqual([['ssh:dispatch', 1]])
    } finally {
      hosts.options = before
    }
  })

  // Why (C3 step 5): a process running in the background on this computer is shown in the
  // sidebar's "Running in the background" group, so the switch counts it under this computer.
  it('counts background processes under their own host and shares the filter with their group', () => {
    useBackgroundRuntimeTerminals.setState({
      terminals: [
        {
          ptyId: 'pty-orphan',
          worktreeId: 'repo::/ads',
          tabId: 'tab-orphan',
          paneKey: 'tab-orphan:leaf-1',
          handle: 'term_orphan',
          title: 'claude conversation',
          launchAgent: 'claude',
          hostId: 'local'
        }
      ]
    })
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, RUNS))

    expect([...result.current.bar.sessionCounts]).toEqual([
      ['local', 3],
      ['runtime:bigmac', 1]
    ])
    act(() => result.current.bar.setHostFilter({ kinds: ['runtime'], hiddenHostIds: [] }))
    expect(useBackgroundRuntimeTerminals.getState().hostFilter).toEqual({
      kinds: ['runtime'],
      hiddenHostIds: []
    })
  })

  it('does not count a background process twice when a sidebar row already shows its pane', () => {
    useBackgroundRuntimeTerminals.setState({
      terminals: [
        {
          ptyId: 'pty-row',
          worktreeId: 'repo::/ads',
          tabId: 'tab-row',
          paneKey: 'tab-row:leaf-1',
          handle: 'term_row',
          title: 'already a row',
          launchAgent: 'claude',
          hostId: 'local'
        }
      ]
    })
    const row = {
      rowKey: 'row',
      sessionKey: 'row',
      hostId: 'local',
      paneKey: 'tab-row:leaf-1'
    } as unknown as SidebarSession
    const { result } = renderHook(() => useSessionHostScope([...SESSIONS, row], RUNS))

    expect([...result.current.bar.sessionCounts]).toEqual([
      ['local', 3],
      ['runtime:bigmac', 1]
    ])
    expect(useBackgroundRuntimeTerminals.getState().sidebarPaneKeys.has('tab-row:leaf-1')).toBe(
      true
    )
  })
})
