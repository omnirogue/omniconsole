import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../../shared/tab-types'
import { createSessionViewModeSelector } from './session-view-mode-selector'

function source(mode: 'chat' | 'terminal') {
  return {
    settings: { experimentalNativeChat: true } as AppState['settings'],
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    unifiedTabsByWorktree: {
      folder: [
        { id: 'unified', entityId: 'terminal', contentType: 'terminal', viewMode: mode } as Tab
      ]
    }
  }
}

describe('session view icon selector', () => {
  const select = createSessionViewModeSelector({
    kind: 'terminal',
    worktreeId: 'folder',
    tabId: 'terminal'
  })
  it('resolves the terminal entity id through the cached unified tab index', () => {
    const state = source('chat')
    expect(select(state)).toBe('chat')
    expect(select(state)).toBe('chat')
    expect(select(source('terminal'))).toBe('terminal')
  })
  it('ignores unrelated workspaces and honors the chat preference', () => {
    const state = source('chat')
    expect(
      select({ ...state, unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, unrelated: [] } })
    ).toBe('chat')
    expect(
      select({ ...state, settings: { experimentalNativeChat: false } as AppState['settings'] })
    ).toBe('terminal')
  })
  it('keeps structured sessions in chat and missing terminals in terminal mode', () => {
    expect(
      createSessionViewModeSelector({ kind: 'structured', worktreeId: 'remote', tabId: 'sdk' })(
        source('terminal')
      )
    ).toBe('chat')
    expect(
      createSessionViewModeSelector({ kind: 'terminal', worktreeId: 'missing', tabId: 'terminal' })(
        source('chat')
      )
    ).toBe('terminal')
    expect(
      createSessionViewModeSelector({ kind: 'terminal', worktreeId: 'folder', tabId: null })(
        source('chat')
      )
    ).toBe('terminal')
  })
})

it('labels only the chat-owning split leaf as Chat', () => {
  const state = source('chat')
  const row = { kind: 'terminal' as const, worktreeId: 'folder', tabId: 'terminal' }
  expect(createSessionViewModeSelector({ ...row, paneKey: 'terminal:first' }, 'first')(state)).toBe(
    'chat'
  )
  expect(
    createSessionViewModeSelector({ ...row, paneKey: 'terminal:second' }, 'first')(state)
  ).toBe('terminal')
  expect(
    createSessionViewModeSelector({ ...row, paneKey: 'terminal:second' }, 'second')(state)
  ).toBe('chat')
})

it('restores only the persisted owner before an unvisited worktree mounts', () => {
  const state = source('chat')
  state.terminalLayoutsByTabId.terminal = {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'first' },
      second: { type: 'leaf', leafId: 'second' }
    },
    activeLeafId: 'second',
    expandedLeafId: null
  }
  const row = { kind: 'terminal' as const, worktreeId: 'folder', tabId: 'terminal' }
  expect(createSessionViewModeSelector({ ...row, paneKey: 'terminal:second' })(state)).toBe('chat')
  expect(createSessionViewModeSelector({ ...row, paneKey: 'terminal:first' })(state)).toBe(
    'terminal'
  )
  expect(createSessionViewModeSelector({ ...row, paneKey: 'terminal:second' }, null)(state)).toBe(
    'terminal'
  )
  expect(createSessionViewModeSelector({ ...row, paneKey: 'terminal:first' }, 'first')(state)).toBe(
    'chat'
  )
  state.terminalLayoutsByTabId.terminal = {
    root: { type: 'leaf', leafId: 'first' },
    activeLeafId: null,
    expandedLeafId: null
  }
  expect(createSessionViewModeSelector({ ...row, paneKey: 'terminal:first' })(state)).toBe('chat')
})
