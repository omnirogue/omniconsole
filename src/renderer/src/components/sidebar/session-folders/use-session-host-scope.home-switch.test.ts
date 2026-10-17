// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { HOME_SESSION_HOST_FILTER, withSessionHostFilter } from '@/lib/session-host-scope'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionHostScope } from './use-session-host-scope'

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
    },
    {
      id: 'runtime:mini',
      kind: 'runtime',
      label: 'mw0003',
      detail: '',
      health: 'available',
      presence: 'configured'
    }
  ]
}))
// The launch owner, and the round trips a pick waits on, each settled when the test says so.
const owner = vi.hoisted(() => ({
  settings: { activeRuntimeEnvironmentId: 'bigmac' as string | null },
  switches: [] as (() => void)[],
  fetches: [] as (() => void)[]
}))
vi.mock('../use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: hosts.options, hostScopeOptions: [] })
}))
vi.mock('./new-conversation/launch-context', () => ({
  useLaunchContext: { getState: () => ({ setTarget: () => {} }) }
}))
vi.mock('@/store', () => {
  const state = () => ({
    sshTargetLabels: new Map(),
    repos: [],
    runtimeEnvironments: [{ id: 'bigmac', name: 'BigMac' }],
    settings: owner.settings,
    setActiveRuntimeEnvironmentPreference: (id: string | null) =>
      new Promise<boolean>((resolve) => {
        owner.switches.push(() => {
          owner.settings = { activeRuntimeEnvironmentId: id }
          resolve(true)
        })
      }),
    fetchFolderWorkspaces: () =>
      new Promise<void>((resolve) => {
        owner.fetches.push(resolve)
      })
  })
  const useAppStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

const session = (key: string, hostId: SidebarSession['hostId']) =>
  ({ rowKey: key, sessionKey: key, hostId, paneKey: null }) as unknown as SidebarSession
const SESSIONS = [session('here', 'local'), session('there', 'runtime:bigmac')]
const GLOBE = { kinds: ['local', 'runtime'] as const, hiddenHostIds: [] }
const MINI_ONLY = { kinds: ['runtime'], hiddenHostIds: ['runtime:bigmac'] }

/** Lets the next queued round trip of a pick finish, once it has been requested. */
async function settle(queue: (() => void)[]): Promise<void> {
  await vi.waitFor(() => expect(queue.length).toBeGreaterThan(0))
  await act(async () => {
    queue.shift()?.()
    await Promise.resolve()
  })
}

beforeEach(() => {
  owner.settings = { activeRuntimeEnvironmentId: 'bigmac' }
  owner.switches = []
  owner.fetches = []
  useSessionSidebarView.setState({
    view: withSessionHostFilter(emptySessionSidebarView(), GLOBE, 'all'),
    loaded: true
  })
})

describe('Home and the Globe while launches switch computers', () => {
  it('keeps a Globe click made while Home is still bringing launches home', async () => {
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, []))
    const keys = () => result.current.sessions.map((entry) => entry.rowKey)
    expect(keys()).toEqual(['here', 'there'])
    // Home: the bar writes the view at once, then asks the hook to move launches home.
    let home!: Promise<boolean>
    act(() => {
      result.current.bar.setHostFilter(HOME_SESSION_HOST_FILTER)
      home = result.current.bar.selectHost('local')
    })
    expect(keys()).toEqual(['here'])
    await settle(owner.switches)
    // The Globe, clicked while that switch is still fetching.
    act(() => result.current.bar.setHostFilter(GLOBE))
    expect(keys()).toEqual(['here', 'there'])
    await settle(owner.fetches)
    await expect(home).resolves.toBe(true)
    expect(result.current.bar.filter).toEqual(GLOBE)
    expect(keys()).toEqual(['here', 'there'])
    expect(owner.settings.activeRuntimeEnvironmentId).toBeNull()
  })

  it('narrows to the computer picked once the switch lands, when nothing moved meanwhile', async () => {
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, []))
    let pick!: Promise<boolean>
    act(() => {
      pick = result.current.bar.selectHost('runtime:mini')
    })
    await settle(owner.switches)
    await settle(owner.fetches)
    await expect(pick).resolves.toBe(true)
    expect(result.current.bar.filter).toEqual(MINI_ONLY)
    expect(owner.settings.activeRuntimeEnvironmentId).toBe('mini')
  })

  it('a computer picked while Home is still switching narrows to it once it lands', async () => {
    const { result } = renderHook(() => useSessionHostScope(SESSIONS, []))
    let home!: Promise<boolean>
    let pick!: Promise<boolean>
    act(() => {
      result.current.bar.setHostFilter(HOME_SESSION_HOST_FILTER)
      home = result.current.bar.selectHost('local')
    })
    await settle(owner.switches)
    // The chevron pick begins while Home is still fetching, and waits on its own switch.
    act(() => {
      pick = result.current.bar.selectHost('runtime:mini')
    })
    // Home lands first and writes Home again, the same view in a new object.
    await settle(owner.fetches)
    await expect(home).resolves.toBe(true)
    expect(result.current.bar.filter).toEqual(HOME_SESSION_HOST_FILTER)
    // Then the pick lands: nobody moved the view, so it narrows to the computer picked.
    await settle(owner.switches)
    await settle(owner.fetches)
    await expect(pick).resolves.toBe(true)
    expect(result.current.bar.filter).toEqual(MINI_ONLY)
    expect(owner.settings.activeRuntimeEnvironmentId).toBe('mini')
  })
})
