// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionGrid } from '@/store/session-grid'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { getDefaultSettings, getDefaultUIState } from '../../../shared/constants'
import {
  commandCenterTarget,
  isCommandCenterView,
  isSessionGridView,
  openCommandCenter
} from './command-center-navigation'
import { shouldSwitchToTerminalViewOnActivation } from './attention-view-activation'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

beforeEach(() => {
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
  vi.stubGlobal('api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(() => {
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('command center navigation and rollback', () => {
  it('defaults off and retains both persisted view ids', () => {
    expect(getDefaultSettings('/tmp').commandCenter).toBe(false)
    expect(isCommandCenterView('attention')).toBe(true)
    expect(isCommandCenterView('grid')).toBe(true)
    expect(isCommandCenterView('work')).toBe(false)
  })

  for (const enabled of [false, true]) {
    it(`routes openers, Work and startup fallback with commandCenter=${enabled}`, () => {
      const store = createTestStore()
      store.setState({ settings: { ...getDefaultSettings('/tmp'), commandCenter: enabled } })
      store.getState().setActiveView('tasks')
      openCommandCenter(store.getState())
      expect(store.getState().activeView).toBe(enabled ? 'attention' : 'grid')
      store.getState().setActiveView('tasks')
      store.getState().openAttentionPage()
      expect(store.getState().activeView).toBe('attention')
      expect(store.getState().previousViewBeforeAttention).toBe('tasks')
      store.getState().setActiveView('grid')
      store.getState().toggleAttentionPage()
      expect(store.getState().activeView).toBe(enabled ? 'tasks' : 'attention')
      store.getState().openWorkPage()
      expect(store.getState().activeView).toBe(enabled ? 'attention' : 'work')
      store
        .getState()
        .hydratePersistedUI({ ...getDefaultUIState(), activeView: 'activity' }, 'startup')
      expect(store.getState().activeView).toBe(enabled ? 'attention' : 'work')
    })

    for (const view of ['attention', 'grid'] as const) {
      it(`routes startup from ${view} and gates its surface and stay rule (${enabled})`, () => {
        const store = createTestStore()
        store.setState({ settings: { ...getDefaultSettings('/tmp'), commandCenter: enabled } })
        store.getState().hydratePersistedUI({ ...getDefaultUIState(), activeView: view }, 'startup')
        expect(store.getState().activeView).toBe(enabled ? 'attention' : view)
        expect(isSessionGridView(view, enabled)).toBe(enabled || view === 'grid')
        expect(shouldSwitchToTerminalViewOnActivation(view, false, enabled)).toBe(
          !enabled && view === 'grid'
        )
        expect(shouldSwitchToTerminalViewOnActivation(view, true, enabled)).toBe(true)
      })
    }
  }

  it('returns to the originating view after repeated Work opens in the command center', () => {
    const store = createTestStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), commandCenter: true },
      activeView: 'tasks'
    })
    store.getState().openWorkPage()
    store.getState().openWorkPage()
    store.getState().toggleAttentionPage()
    expect(store.getState().activeView).toBe('tasks')
  })

  for (const enabled of [false, true]) {
    it(`keeps Work home reachable and its back navigation intact (${enabled})`, () => {
      const store = createTestStore()
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), commandCenter: enabled },
        activeView: 'tasks'
      })
      store.getState().openWorkHomePage()
      store.getState().openWorkHomePage()
      expect(store.getState().activeView).toBe('work')
      store.getState().closeWorkPage()
      expect(store.getState().activeView).toBe('tasks')
    })
  }

  it('honors a live setting change on the next Work navigation', () => {
    const store = createTestStore()
    store.setState({ settings: { ...getDefaultSettings('/tmp'), commandCenter: true } })
    store.getState().openWorkPage()
    expect(store.getState().activeView).toBe('attention')
    store.setState({ settings: { ...store.getState().settings!, commandCenter: false } })
    store.getState().openWorkPage()
    expect(store.getState().activeView).toBe('work')
  })

  for (const openProjectsOnStart of [false, true]) {
    for (const view of ['terminal', 'work', 'tasks', 'project', 'attention', 'grid'] as const) {
      it(`starts in Attention from ${view} with Projects preference ${openProjectsOnStart}`, () => {
        const store = createTestStore()
        store.setState({
          settings: {
            ...getDefaultSettings('/tmp'),
            commandCenter: true,
            openProjectsOnStart
          }
        })
        store.getState().hydratePersistedUI({ ...getDefaultUIState(), activeView: view }, 'startup')
        expect(store.getState().activeView).toBe('attention')
        store.getState().setActiveView('tasks')
        store.getState().hydratePersistedUI({ ...getDefaultUIState(), activeView: view }, 'sync')
        expect(store.getState().activeView).toBe('tasks')
      })
    }
  }

  it('retains each legacy opener when disabled or absent', () => {
    expect(commandCenterTarget(undefined, 'work')).toBe('work')
    expect(commandCenterTarget(false, 'attention')).toBe('attention')
    expect(commandCenterTarget(false, 'grid')).toBe('grid')
  })
})
