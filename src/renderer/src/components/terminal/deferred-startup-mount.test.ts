import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  isTabHeldUntilRevealed,
  isTabRevealed,
  markDeferredTabsRevealed,
  pendingStartupNeedsImmediateMount,
  resetDeferredStartupMountStateForTests,
  selectRevealDeferredTabIds,
  withholdUnrevealedDeferredTabs
} from './deferred-startup-mount'

afterEach(() => {
  resetDeferredStartupMountStateForTests()
})

const deferred = { command: 'claude --resume a', deferUntilRevealed: true as const }
const eager = { command: 'claude --resume b' }
const tabs = [{ id: 'live' }, { id: 'held-1' }, { id: 'held-2' }, { id: 'active' }]
const noPtys = { tabsByWorktree: {}, ptyIdsByTabId: {} }

describe('deferred startup mount', () => {
  it('forces only eager pending startups into the immediate mount set', () => {
    expect(pendingStartupNeedsImmediateMount(undefined)).toBe(false)
    expect(pendingStartupNeedsImmediateMount(eager)).toBe(true)
    expect(pendingStartupNeedsImmediateMount(true)).toBe(true)
    expect(pendingStartupNeedsImmediateMount(deferred)).toBe(false)
  })

  it('treats deferred startups and re-keyed records as waiting for a reveal', () => {
    const tabIds = selectRevealDeferredTabIds({
      ...noPtys,
      pendingStartupByTabId: { 'held-1': deferred, live: eager },
      sleepingAgentSessionsByPaneKey: {
        'held-2:leaf': { tabId: 'held-2', resumeOnFirstReveal: true } as never,
        'live:leaf': { tabId: 'live' } as never
      }
    })
    expect(tabIds).toEqual(['held-1', 'held-2'])
  })

  it('does not hold a tab for a slept pane while another pane of it still has a live PTY', () => {
    const sleepingAgentSessionsByPaneKey = {
      'split:slept-leaf': {
        tabId: 'split',
        worktreeId: 'wt-1',
        resumeOnFirstReveal: true
      } as never
    }
    const base = { pendingStartupByTabId: {}, sleepingAgentSessionsByPaneKey }
    // A sibling leaf's PTY is still bound to the tab, by the per-tab list or the tab-level id.
    expect(
      selectRevealDeferredTabIds({ ...base, ...noPtys, ptyIdsByTabId: { split: ['pty-b'] } })
    ).toEqual([])
    expect(
      selectRevealDeferredTabIds({
        ...base,
        ...noPtys,
        tabsByWorktree: { 'wt-1': [{ id: 'split', ptyId: 'pty-b' }] }
      })
    ).toEqual([])
    // Once the tab has no live PTY left it waits for its reveal like a lazily restored tab.
    expect(
      selectRevealDeferredTabIds({
        ...base,
        tabsByWorktree: { 'wt-1': [{ id: 'split', ptyId: null }] },
        ptyIdsByTabId: { split: [] }
      })
    ).toEqual(['split'])
  })

  it('tracks the open of a split tab whose slept pane waits for it, though the tab mounts', () => {
    const previous = useAppStore.getState()
    useAppStore.setState({
      pendingStartupByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'split:slept-leaf': {
          tabId: 'split',
          worktreeId: 'wt-1',
          restoreOnTabOpenOnly: true,
          resumeOnFirstReveal: true
        } as never
      },
      tabsByWorktree: { 'wt-1': [{ id: 'split', ptyId: 'pty-b' }] } as never,
      ptyIdsByTabId: { split: ['pty-b'] }
    })
    try {
      const held = new Set(selectRevealDeferredTabIds(useAppStore.getState()))
      expect(held.has('split')).toBe(false)
      // An untargeted background mount, or the workspace shown on another tab, is not its open.
      markDeferredTabsRevealed([], held)
      markDeferredTabsRevealed(['other'], held)
      expect(isTabRevealed('split')).toBe(false)
      // Showing it, or a mount targeted at it, is.
      markDeferredTabsRevealed(['split'], held)
      expect(isTabRevealed('split')).toBe(true)
      // Once its pane resumed and the record cleared, a later sleep waits for a new open.
      useAppStore.setState({ sleepingAgentSessionsByPaneKey: {} })
      markDeferredTabsRevealed([], held)
      expect(isTabRevealed('split')).toBe(false)
    } finally {
      useAppStore.setState({
        pendingStartupByTabId: previous.pendingStartupByTabId,
        sleepingAgentSessionsByPaneKey: previous.sleepingAgentSessionsByPaneKey,
        tabsByWorktree: previous.tabsByWorktree,
        ptyIdsByTabId: previous.ptyIdsByTabId
      })
    }
  })

  it('reuses the selector result until an input map changes identity', () => {
    const state = {
      ...noPtys,
      pendingStartupByTabId: { 'held-1': deferred },
      sleepingAgentSessionsByPaneKey: {}
    }
    const first = selectRevealDeferredTabIds(state)
    expect(selectRevealDeferredTabIds({ ...state })).toBe(first)

    const next = { ...state, pendingStartupByTabId: { 'held-2': deferred } }
    const second = selectRevealDeferredTabIds(next)
    expect(second).toEqual(['held-2'])
    expect(second).not.toBe(first)

    const withSleeping = {
      ...next,
      sleepingAgentSessionsByPaneKey: {
        'held-1:leaf': { tabId: 'held-1', resumeOnFirstReveal: true } as never
      }
    }
    const third = selectRevealDeferredTabIds(withSleeping)
    expect(third).toEqual(['held-1', 'held-2'])
    expect(selectRevealDeferredTabIds({ ...withSleeping })).toBe(third)
    // A PTY map change re-reads liveness: held-1 now has a live PTY, so it no longer waits.
    expect(
      selectRevealDeferredTabIds({ ...withSleeping, ptyIdsByTabId: { 'held-1': ['pty-b'] } })
    ).toEqual(['held-2'])
    expect(selectRevealDeferredTabIds(state)).toEqual(['held-1'])
  })

  it('keeps unrevealed deferred tabs unmounted while the revealed one mounts', () => {
    const deferredTabIds = new Set(['held-1', 'held-2', 'active'])
    markDeferredTabsRevealed(['active'], deferredTabIds)

    const allowed = withholdUnrevealedDeferredTabs('wt-1', null, tabs, deferredTabIds)

    expect([...allowed!].sort()).toEqual(['active', 'live'])
    expect(isTabHeldUntilRevealed('held-1', deferredTabIds)).toBe(true)
    expect(isTabHeldUntilRevealed('active', deferredTabIds)).toBe(false)
  })

  it('narrows an existing restriction instead of widening it', () => {
    const allowed = withholdUnrevealedDeferredTabs(
      'wt-1',
      new Set(['held-1', 'active']),
      tabs,
      new Set(['held-1'])
    )
    expect([...allowed!]).toEqual(['active'])
  })

  it('returns the restriction untouched when nothing is held', () => {
    const restriction = new Set(['live'])
    expect(withholdUnrevealedDeferredTabs('wt-1', restriction, tabs, new Set())).toBe(restriction)
    expect(withholdUnrevealedDeferredTabs('wt-1', null, tabs, new Set())).toBeNull()
  })

  it('keeps the withheld set identity stable across unchanged renders', () => {
    const deferredTabIds = new Set(['held-1'])
    const first = withholdUnrevealedDeferredTabs('wt-1', null, tabs, deferredTabIds)
    const second = withholdUnrevealedDeferredTabs('wt-1', null, [...tabs], new Set(['held-1']))
    expect(second).toBe(first)
  })

  it('keeps a revealed tab mounted after switching away until it spawns', () => {
    const deferredTabIds = new Set(['held-1', 'held-2'])
    markDeferredTabsRevealed(['held-1'], deferredTabIds)
    markDeferredTabsRevealed(['live'], deferredTabIds)

    const allowed = withholdUnrevealedDeferredTabs('wt-1', null, tabs, deferredTabIds)

    expect(allowed!.has('held-1')).toBe(true)
    expect(allowed!.has('held-2')).toBe(false)
  })

  it('forgets a revealed tab once it is no longer deferred', () => {
    markDeferredTabsRevealed(['held-1'], new Set(['held-1']))
    markDeferredTabsRevealed([], new Set())
    expect(isTabHeldUntilRevealed('held-1', new Set(['held-1']))).toBe(true)
  })
})
