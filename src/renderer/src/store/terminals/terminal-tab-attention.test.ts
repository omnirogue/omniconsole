import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const mockApi = {
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import {
  createTestStore,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from '../slices/store-test-helpers'

const WT = 'repo1::/path/wt1'

function makeSeededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('setTabCustomTitle', () => {
  it('names a terminal tab and its strip entry', () => {
    const store = makeSeededStore()
    const tab = store.getState().createTab(WT)
    store.getState().setTabCustomTitle(tab.id, 'Build shell')
    expect(store.getState().tabsByWorktree[WT][0].customTitle).toBe('Build shell')
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[WT].find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tab.id
        )?.customLabel
    ).toBe('Build shell')
  })

  // Why: native chat has no terminal tab, so both renames used to be dropped silently.
  it('names a native chat tab addressed by its tab id (sidebar) or entity id (tab strip)', () => {
    const store = makeSeededStore()
    store.setState({
      unifiedTabsByWorktree: {
        [WT]: [
          makeUnifiedTab({
            id: 'chat-tab',
            entityId: 'chat-entity',
            worktreeId: WT,
            groupId: 'group-1',
            contentType: 'agent-session',
            label: 'Codex Chat'
          })
        ]
      }
    })
    const chat = () => store.getState().unifiedTabsByWorktree[WT][0]
    store.getState().setTabCustomTitle('chat-tab', 'Launch plan')
    expect(chat().customLabel).toBe('Launch plan')
    store.getState().setTabCustomTitle('chat-entity', 'Pricing review')
    expect(chat().customLabel).toBe('Pricing review')
    store.getState().setTabCustomTitle('chat-tab', null)
    expect(chat().customLabel).toBeNull()
  })
})
