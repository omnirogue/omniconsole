import { describe, expect, it, vi } from 'vitest'
import { launchSessionPrepWorktree } from './session-prep-launch-executors'
import type { SessionPrepItemRecord } from './session-prep-records'

describe('session prep worktree launch receipt', () => {
  it('persists the terminal handle before lookup and returns the resolved surface identity', async () => {
    const item = {
      index: 0,
      planned: { title: 'Parser', ask: 'fix parser' },
      state: 'planned'
    } as SessionPrepItemRecord
    const batch = { id: 'sp_batch', state: 'running', items: [item] } as never
    const persist = vi.fn(async () => undefined)
    const resolveTerminalPaneKey = vi.fn(async () => {
      expect(persist).toHaveBeenCalledTimes(2)
      expect(item.launched?.paneHandle).toBe('terminal-handle')
      expect(item.launched?.paneIdentity).toBe('pending')
      return 'stable-pane-key'
    })
    const host = {
      createWorktreeWithAgent: async () => ({
        worktreeId: 'repo::/new-worktree',
        paneHandle: 'terminal-handle',
        surface: { tabId: 'tab-new' }
      }),
      resolveTerminalPaneKey
    } as never
    const result = await launchSessionPrepWorktree(
      {
        host,
        steps: () => ({}) as never,
        now: () => 10,
        persist,
        isCancelled: () => false,
        batch: () => batch
      },
      batch,
      item,
      'repo',
      { agent: 'claude' } as never,
      'prompt',
      1
    )
    expect(resolveTerminalPaneKey).toHaveBeenCalledWith('terminal-handle')
    expect(item.launched).toMatchObject({
      paneKey: 'stable-pane-key',
      paneHandle: 'terminal-handle'
    })
    expect(result).toEqual({ tabId: 'tab-new', paneKey: 'stable-pane-key' })
    expect(persist).toHaveBeenCalledTimes(3)
  })
})
