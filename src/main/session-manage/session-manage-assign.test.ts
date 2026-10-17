import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { assignSession } from './session-manage-assign'
import { SessionManageRefusal, type SessionDeliveryDeps } from './session-manage-deliver'
import { FREEFORM_NOT_AN_APPROVAL } from './session-manage-freeform'
import { agentProcess, manageEntry } from './session-manage-test-fixtures'

const source: ConversationSource = {
  worktreeId: 'repo::/ads',
  paneKey: 'tab-2:leaf-2',
  kind: 'pty'
}
const asker: SessionManageActor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Planner' }

function deps(): SessionDeliveryDeps {
  const latest = {
    known: true,
    turnKey: 't1',
    text: 'The fetcher reads the report now.',
    complete: true,
    proposal: null,
    empty: false
  }
  return {
    enqueue: vi.fn(),
    admission: vi.fn(() => null),
    bind: vi.fn(() => () => {}),
    readLatestTurn: vi.fn(async () => latest),
    snapshotLatestTurn: vi.fn(() => latest),
    hasUnresolvedDraft: vi.fn(() => false),
    decideRelayed: vi.fn(),
    stopKeepGoing: vi.fn(() => false),
    readOwnSteps: vi.fn(async () => ({ set: null, steps: [] })),
    newId: () => 'id-1'
  }
}

const target = (overrides = {}) => ({
  entry: manageEntry({ title: 'Ads fetcher', ...overrides }),
  source,
  agentProcess: agentProcess()
})

describe('session assign', () => {
  it('queues the task behind "[from <asker>] New task for you:" through continue --prompt', async () => {
    const d = deps()
    const { result, entryId } = await assignSession(d, {
      actor: asker,
      target: target(),
      task: 'Add retry with backoff to the report fetcher.',
      bound: false,
      dryRun: false
    })
    expect(d.enqueue).toHaveBeenCalledWith(source, {
      id: 'session-manage:id-1',
      text: `[from Planner] New task for you: ${FREEFORM_NOT_AN_APPROVAL}\nAdd retry with backoff to the report fetcher.`,
      requestedBy: { action: 'continue', actor: 'tab-9:leaf-9' }
    })
    expect(entryId).toBe('session-manage:id-1')
    expect(result).toMatchObject({
      action: 'assign',
      dryRun: false,
      summary: 'Gave “Ads fetcher” a new task from Planner. It is sent when “Ads fetcher” is free.'
    })
  })

  it('refuses, sending nothing, when the target became busy since find-owner', async () => {
    for (const [overrides, bound, words] of [
      [{ state: 'working' }, false, 'working'],
      [{ queueLength: 2 }, false, 'queue'],
      [{}, true, 'outcome run or session chain']
    ] as const) {
      const d = deps()
      const refused = assignSession(d, {
        actor: asker,
        target: target(overrides),
        task: 'Add retry.',
        bound,
        dryRun: false
      })
      await expect(refused).rejects.toBeInstanceOf(SessionManageRefusal)
      await expect(refused).rejects.toThrow(`“Ads fetcher” is no longer free`)
      await expect(refused).rejects.toThrow(words)
      expect(d.enqueue).not.toHaveBeenCalled()
    }
  })

  it('refuses a session a routine owns, even when it is idle', async () => {
    const d = deps()
    const refused = assignSession(d, {
      actor: asker,
      target: target(),
      task: 'Add retry.',
      bound: false,
      routine: true,
      dryRun: false
    })
    await expect(refused).rejects.toThrow('“Ads fetcher” belongs to a routine')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('keeps continue --prompt’s hard stops on the task text', async () => {
    const d = deps()
    await expect(
      assignSession(d, {
        actor: asker,
        target: target(),
        task: 'Deploy the fetcher to production.',
        bound: false,
        dryRun: false
      })
    ).rejects.toThrow(/hard stop/i)
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('changes nothing on a dry run', async () => {
    const d = deps()
    const { result } = await assignSession(d, {
      actor: asker,
      target: target(),
      task: 'Add retry.',
      bound: false,
      dryRun: true
    })
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(result.summary).toContain('Would give “Ads fetcher” this task from Planner')
  })
})
