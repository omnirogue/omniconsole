import { expect, it, vi } from 'vitest'
import {
  launchSessionPrepSession,
  launchSessionPrepWorktree
} from './session-prep-launch-executors'
import { SessionPrepRoutedModelUnavailableError } from './session-prep-routed-launch'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'

it.each(['session', 'worktree'] as const)(
  'records a routed account refusal without a launched selection for %s',
  async (kind) => {
    const create = vi.fn(async () => {
      throw new SessionPrepRoutedModelUnavailableError(
        'Chosen account does not advertise Luna. Nothing launched.'
      )
    })
    const persist = vi.fn(async () => {})
    const ctx = {
      host: { createAgentSessionIn: create, createWorktreeWithAgent: create },
      persist,
      now: () => 1,
      isCancelled: () => false
    } as unknown as SessionPrepLaunchContext
    const batch: SessionPrepBatchRecord = {
      id: 'batch',
      state: 'running',
      createdAt: 0,
      updatedAt: 0,
      source: { worktreeId: 'workspace', paneKey: 'pane', agent: 'codex' },
      request: 'Task',
      context: '',
      dropped: [],
      items: []
    }
    const item: SessionPrepItemRecord = {
      index: 0,
      state: 'launching',
      planned: { title: 'Task', ask: 'Task', anchor: 'Task', direct: true, changesCode: false },
      verdicts: [],
      repairs: 0,
      route: {
        provider: 'codex',
        model: 'gpt-6-luna',
        mode: 'live',
        at: 0,
        tier: 'fast',
        gate: 'rules',
        reason: 'Simple task',
        note: ''
      }
    }
    const choice = {
      agent: 'codex' as const,
      model: 'gpt-6-luna',
      routedModel: 'gpt-6-luna',
      notes: []
    }
    await (kind === 'session'
      ? launchSessionPrepSession(ctx, batch, item, 'workspace', choice, 'Work', 1)
      : launchSessionPrepWorktree(ctx, batch, item, 'repo', choice, 'Work', 1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ routedModel: 'gpt-6-luna' }))
    expect(item.state).toBe('failed')
    expect(item.launched).toBeUndefined()
    expect(item.route).toMatchObject({ status: 'unavailable', blocking: true, mode: 'live' })
    expect(item.route).not.toHaveProperty('model')
    expect(item.note).toContain('Nothing launched')
    expect(persist).toHaveBeenCalledTimes(2)
  }
)
