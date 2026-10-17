import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveAttentionCurrentSurface,
  selectAttentionCurrentSurfaceInputs
} from './attention-current-surface'
import { ATTENTION_FIXTURE_LEAF_A, attentionFixtureTab } from './attention-test-fixtures'

const tab = attentionFixtureTab('tab-a', 'w1', 'pty-a')
const layout = {
  root: { type: 'leaf' as const, leafId: ATTENTION_FIXTURE_LEAF_A },
  activeLeafId: ATTENTION_FIXTURE_LEAF_A,
  expandedLeafId: null
}

describe('resolveAttentionCurrentSurface', () => {
  it('isolates the active leaf of the active terminal tab', () => {
    const surface = resolveAttentionCurrentSurface(
      selectAttentionCurrentSurfaceInputs({
        activeWorktreeId: 'w1',
        activeTabId: 'tab-a',
        activeTabType: 'terminal',
        tabsByWorktree: { w1: [{ ...tab, customTitle: 'Ship it' }] },
        terminalLayoutsByTabId: { 'tab-a': layout }
      })
    )
    expect(surface).toEqual({
      kind: 'terminal',
      pane: {
        worktreeId: 'w1',
        tabId: 'tab-a',
        paneKey: makePaneKey('tab-a', ATTENTION_FIXTURE_LEAF_A),
        label: 'Ship it',
        agent: 'claude'
      }
    })
  })

  it('shows the whole tab while its layout has no leaf yet', () => {
    const surface = resolveAttentionCurrentSurface(
      selectAttentionCurrentSurfaceInputs({
        activeWorktreeId: 'w1',
        activeTabId: 'tab-a',
        activeTabType: 'terminal',
        tabsByWorktree: { w1: [tab] },
        terminalLayoutsByTabId: {}
      })
    )
    expect(surface).toMatchObject({
      kind: 'terminal',
      pane: { paneKey: '', label: 'Terminal tab-a' }
    })
  })

  it('reports a non-terminal active tab and an empty workspace', () => {
    expect(
      resolveAttentionCurrentSurface(
        selectAttentionCurrentSurfaceInputs({
          activeWorktreeId: 'w1',
          activeTabId: 'tab-a',
          activeTabType: 'editor',
          tabsByWorktree: { w1: [tab] },
          terminalLayoutsByTabId: { 'tab-a': layout }
        })
      )
    ).toEqual({ kind: 'other', worktreeId: 'w1' })
    expect(
      resolveAttentionCurrentSurface(
        selectAttentionCurrentSurfaceInputs({
          activeWorktreeId: null,
          activeTabId: null,
          activeTabType: 'terminal',
          tabsByWorktree: {},
          terminalLayoutsByTabId: {}
        })
      )
    ).toEqual({ kind: 'none' })
  })
})

describe('selectAttentionCurrentSurfaceInputs', () => {
  // Why: `useShallow` compares one level, so a fresh `[]` per read re-renders the page forever
  // (React #185) exactly when nothing is selected — the state the page must draw as empty.
  it('reads shallow-equal inputs when no workspace is active', () => {
    const state = {
      activeWorktreeId: null,
      activeTabId: null,
      activeTabType: 'terminal' as const,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    expect(
      shallow(
        selectAttentionCurrentSurfaceInputs(state),
        selectAttentionCurrentSurfaceInputs(state)
      )
    ).toBe(true)
  })

  it('reads shallow-equal inputs for a workspace whose tabs have not registered yet', () => {
    const state = {
      activeWorktreeId: 'w1',
      activeTabId: 'tab-a',
      activeTabType: 'terminal' as const,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    expect(
      shallow(
        selectAttentionCurrentSurfaceInputs(state),
        selectAttentionCurrentSurfaceInputs(state)
      )
    ).toBe(true)
  })
})
