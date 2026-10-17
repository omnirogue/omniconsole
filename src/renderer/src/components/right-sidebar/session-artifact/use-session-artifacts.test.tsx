// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

type TestStore = {
  activeView: string
  activeWorktreeId: string | null
  tabId: string | null
  leafId: string | null
  rightSidebarOpen: boolean
  rightSidebarRouteRequestId: number
  settings: Record<string, unknown>
  setRightSidebarOpen: (open: boolean) => void
}

const store = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/store', () => ({ useAppStore: store.current }))
vi.mock('@/lib/sidebar-session-on-screen', () => ({
  selectOnScreenSessionTabId: (s: TestStore) => s.tabId,
  selectOnScreenSessionLeafId: (s: TestStore) => s.leafId
}))
vi.mock('./session-artifact-client', () => ({
  listSessionArtifactRecords: async () => [],
  listSessionLinkedDocs: async () => []
}))
vi.mock('../../../../../shared/backoffice-connection', () => ({
  resolveBackofficeBaseUrl: () => ({ configured: true, baseUrl: 'https://omnios.example' })
}))

const useTestStore = create<TestStore>((set) => ({
  activeView: 'terminal',
  activeWorktreeId: 'w',
  tabId: 'tab',
  leafId: null,
  rightSidebarOpen: false,
  rightSidebarRouteRequestId: 0,
  settings: {},
  setRightSidebarOpen: (open) => set({ rightSidebarOpen: open })
}))
store.current = useTestStore

const { useSessionArtifacts } = await import('./use-session-artifacts')
const { captureSessionFileOpener, tryOpenSessionDocument } =
  await import('@/lib/session-document-routing')
const { useSessionWorkView } = await import('./session-work-view-store')

const PLAN_URL = 'https://example.slite.com/app/docs/JoYrquxoLA9fnk'

beforeEach(() => {
  useTestStore.setState({ rightSidebarOpen: false, rightSidebarRouteRequestId: 0 })
  useSessionWorkView.setState({ preferred: true })
})
afterEach(() => cleanup())

describe('useSessionArtifacts', () => {
  it('never expands a collapsed panel for a clicked link, but keeps it with the session', () => {
    const { result } = renderHook(() => useSessionArtifacts())
    let handled = true
    act(() => {
      handled = tryOpenSessionDocument(PLAN_URL, 'w')
    })
    expect(handled).toBe(false)
    expect(useTestStore.getState().rightSidebarOpen).toBe(false)
    expect(result.current.artifacts.map((item) => item.key)).toEqual(['slite:JoYrquxoLA9fnk'])
    expect(useSessionWorkView.getState().plans).toBe(1)
    act(() => {
      handled = captureSessionFileOpener()('/w/notes.md', { worktreeId: 'w' } as never)
    })
    expect(handled).toBe(false)
    expect(useTestStore.getState().rightSidebarOpen).toBe(false)
  })

  it('shows the clicked document in a panel the person already opened', () => {
    useTestStore.setState({ rightSidebarOpen: true })
    useSessionWorkView.setState({ preferred: false })
    const { result } = renderHook(() => useSessionArtifacts())
    let handled = false
    act(() => {
      handled = tryOpenSessionDocument(PLAN_URL, 'w')
    })
    expect(handled).toBe(true)
    expect(result.current.pickedKey).toBe('slite:JoYrquxoLA9fnk')
    expect(result.current.active).toBe(true)
  })

  it('opens the panel only on the person’s own choice, and remembers a developer tab', () => {
    const { result } = renderHook(() => useSessionArtifacts())
    expect(result.current.active).toBe(true)
    act(() => result.current.leaveArtifactMode())
    expect(result.current.active).toBe(false)
    expect(useTestStore.getState().rightSidebarOpen).toBe(false)
    act(() => result.current.selectArtifactMode())
    expect(result.current.active).toBe(true)
    expect(useTestStore.getState().rightSidebarOpen).toBe(true)
  })
})
