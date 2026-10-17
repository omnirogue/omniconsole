import { describe, expect, it, vi } from 'vitest'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import type { SessionPrepBatchRecord } from './session-prep-records'
import { resumeSessionPrepBatch } from './session-prep-resume'

function finishedBatch(): SessionPrepBatchRecord {
  return {
    id: 'batch-1',
    createdAt: 1,
    updatedAt: 1,
    state: 'done',
    request: 'create a session for the login fix',
    context: '',
    dropped: [],
    items: [
      {
        index: 0,
        planned: {
          title: 'Login fix',
          ask: 'fix login',
          anchor: 'login',
          direct: false,
          changesCode: true
        },
        state: 'launched',
        fields: {
          title: 'Login fix',
          outcome: 'Login keeps a 30 second timeout',
          doneWhen: ['pnpm test auth exits 0', 'config/auth.ts sets 30 seconds'],
          decided: [],
          references: [],
          constraints: [],
          assumptions: [],
          blockingQuestion: null,
          changesCode: true
        },
        verdicts: [],
        repairs: 0,
        launched: { worktreeId: 'repo::/wt/login', newWorkspace: true, at: 1, paneKey: 'pane-1' },
        verifyPending: { agent: 'claude' }
      }
    ]
  } as unknown as SessionPrepBatchRecord
}

describe('a verify binding pending when the app stopped', () => {
  it('is resumed for a finished batch, then cleared and noted', async () => {
    const attachVerify = vi.fn(async () => ({ attached: true as const }))
    const persist = vi.fn(async () => {})
    const batch = finishedBatch()
    const ctx = { host: { attachVerify }, persist } as unknown as SessionPrepLaunchContext

    await expect(resumeSessionPrepBatch(ctx, batch)).resolves.toBe('idle')
    await vi.waitFor(() => expect(batch.items[0]!.verifyPending).toBeUndefined())

    expect(attachVerify).toHaveBeenCalledWith({
      worktreeId: 'repo::/wt/login',
      paneKey: 'pane-1',
      title: 'Login fix',
      doneWhen: ['pnpm test auth exits 0', 'config/auth.ts sets 30 seconds'],
      agent: 'claude'
    })
    expect(batch.items[0]!.note).toContain('Verify attached')
  })

  it('keeps the binding pending while the pane is unknown, and stops retrying after three starts', async () => {
    const persist = vi.fn(async () => {})
    const attachVerify = vi.fn(async () => ({ attached: true as const }))
    const batch = finishedBatch()
    const item = batch.items[0]!
    item.launched = {
      worktreeId: 'repo::/wt/login',
      newWorkspace: true,
      at: 1,
      paneHandle: 'term_1'
    }
    const ctx = {
      host: { attachVerify, resolveTerminalPaneKey: async () => null },
      persist
    } as unknown as SessionPrepLaunchContext
    for (const expected of [1, 2]) {
      await resumeSessionPrepBatch(ctx, batch)
      await vi.waitFor(() => expect(item.note).toContain('not known yet'))
      expect(item.verifyPending).toEqual({ agent: 'claude', attempts: expected })
      item.note = undefined
    }
    await resumeSessionPrepBatch(ctx, batch)
    await vi.waitFor(() => expect(item.verifyPending?.exhausted).toBe(true))
    expect(item.note).toContain('Stopped retrying after 3 tries')
    // Kept on record, but no longer retried automatically.
    item.note = undefined
    await resumeSessionPrepBatch(ctx, batch)
    expect(item.verifyPending).toEqual({ agent: 'claude', attempts: 3, exhausted: true })
    expect(attachVerify).not.toHaveBeenCalled()
  })
})
