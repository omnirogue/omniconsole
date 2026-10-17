import { describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createTerminalLayoutActions } from './terminal-layout-state'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'

function expandStore() {
  const store = createStore(() => ({
    expandedPaneByTabId: {} as Record<string, boolean>,
    canExpandPaneByTabId: {} as Record<string, boolean>
  }))
  const actions = createTerminalLayoutActions(
    store.setState as unknown as TerminalStoreSet,
    store.getState as unknown as TerminalStoreGet
  )
  const listener = vi.fn()
  store.subscribe(listener)
  return { store, actions, listener }
}

describe('terminal pane expand flags', () => {
  it('notifies nobody when a pane reports the flag it already has, missing counting as false', () => {
    const { store, actions, listener } = expandStore()
    actions.setTabPaneExpanded('tab-1', false)
    actions.setTabCanExpandPane('tab-1', false)
    expect(listener).not.toHaveBeenCalled()
    actions.setTabPaneExpanded('tab-1', true)
    actions.setTabPaneExpanded('tab-1', true)
    actions.setTabCanExpandPane('tab-1', true)
    actions.setTabCanExpandPane('tab-1', true)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getState()).toEqual({
      expandedPaneByTabId: { 'tab-1': true },
      canExpandPaneByTabId: { 'tab-1': true }
    })
    actions.setTabPaneExpanded('tab-1', false)
    expect(store.getState().expandedPaneByTabId).toEqual({ 'tab-1': false })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
