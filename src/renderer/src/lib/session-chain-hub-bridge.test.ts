import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = {
  list: vi.fn(),
  sendCardless: vi.fn(),
  respond: vi.fn()
}

vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))

import { receivedRow, sentRow } from '../../../shared/backoffice-work-rows'
import type { SessionChain, SessionChainAgentStep } from '../../../shared/session-chain-types'
import {
  announceChainStep,
  currentEmployeeId,
  reportChainFailure,
  resetCurrentEmployeeIdForTests,
  settleChainStep,
  unsettledChainSteps
} from './session-chain-hub-bridge'

function step(patch: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep {
  return {
    id: 'step_1_abc',
    agent: 'claude' as SessionChainAgentStep['agent'],
    prompt: 'Research the lander',
    status: 'launched',
    ...patch
  }
}

function chain(steps: SessionChainAgentStep[]): SessionChain {
  return {
    id: 'chn_1',
    workspacePath: '/Users/maintainer/repo',
    worktreeId: 'w1',
    hostId: null,
    sourcePaneKey: 'tab:1:pane:1',
    sourceRowKey: 'Seedance lander',
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

function access(initial: SessionChain) {
  let current: SessionChain | null = initial
  return {
    getChain: () => current,
    update: (patch: Partial<SessionChain>) => {
      current = current ? { ...current, ...patch } : null
      return current
    },
    persist: vi.fn().mockResolvedValue(undefined),
    read: () => current
  }
}

beforeEach(() => {
  resetCurrentEmployeeIdForTests()
  api.list.mockReset()
  api.sendCardless.mockReset()
  api.respond.mockReset()
  api.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal', threads: [] } })
  api.sendCardless.mockResolvedValue({ ok: true, data: { thread_id: 'hth_step1' } })
  api.respond.mockResolvedValue({ ok: true, data: { thread_id: 'hth_step1' } })
})

describe('the record an agent step leaves in the hub', () => {
  it('opens one fyi thread from the owner to the owner, with a deterministic operation id', async () => {
    const store = access(chain([step()]))

    const threadId = await announceChainStep(store, step(), 'Seedance lander')

    expect(threadId).toBe('hth_step1')
    expect(api.sendCardless).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: 'emp_sal',
        action: 'fyi',
        operationId: 'chain_chn_1_step_step_1_abc',
        attachments: []
      })
    )
    const sent = api.sendCardless.mock.calls[0]![0]
    expect(sent.title).toBe('claude: Seedance lander')
    expect(sent.note).toContain('Research the lander')
    // The thread id is saved on the step, so a restart settles the same thread.
    expect(store.read()?.steps[0]).toMatchObject({ hubThreadId: 'hth_step1' })
    expect(store.persist).toHaveBeenCalled()
  })

  it('that thread sits in Waiting For and never in Needs You while the step runs', () => {
    const thread = {
      id: 'hth_step1',
      board_task_id: null,
      author_employee_id: 'emp_sal',
      recipient_employee_id: 'emp_sal',
      title: 'claude: Seedance lander',
      state: 'open' as const,
      action: 'fyi' as const,
      due_at: null,
      parent_thread_id: null,
      delivery_id: null,
      updated: '2026-09-14T12:00:00Z',
      files: [],
      reviews: []
    }
    expect(sentRow(thread)).toMatchObject({ waitingFor: true, needsYou: false })
    // The view drops a self-addressed thread from the received side entirely (see
    // backoffice-work-views.self-thread.test); a resolved one claims neither tab regardless.
    expect(receivedRow({ ...thread, state: 'resolved' as const })).toMatchObject({
      needsYou: false,
      waitingFor: false
    })
  })

  it('finishing resolves the thread with the done entry, once', async () => {
    const launched = step({ hubThreadId: 'hth_step1' })
    const store = access(chain([launched]))

    await settleChainStep(store, launched, { ok: true })

    expect(api.respond).toHaveBeenCalledWith({
      threadId: 'hth_step1',
      kind: 'done',
      note: 'claude finished this step.',
      operationId: 'chain_chn_1_step_step_1_abc_done'
    })
    const settled = store.read()!.steps[0] as SessionChainAgentStep
    expect(settled.hubSettledAt).toBeTypeOf('number')

    await settleChainStep(store, settled, { ok: true })
    expect(api.respond).toHaveBeenCalledTimes(1)
  })

  it('a failed chain replies on every open step thread, which is what reaches Needs You', async () => {
    const store = access(
      chain([
        step({ id: 'step_1', hubThreadId: 'hth_1' }),
        step({ id: 'step_2', hubThreadId: 'hth_2', hubSettledAt: 5 })
      ])
    )

    await reportChainFailure(store, 'The next session could not be started.')

    expect(api.respond).toHaveBeenCalledTimes(1)
    expect(api.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'hth_1',
        kind: 'reply',
        operationId: 'chain_chn_1_step_step_1_failed_1'
      })
    )
    expect(unsettledChainSteps(store.read()!)).toHaveLength(0)
  })

  it('never fails the run when the console is unreachable', async () => {
    api.list.mockRejectedValue(new Error('offline'))
    const store = access(chain([step()]))

    await expect(announceChainStep(store, step(), 'x')).resolves.toBeNull()
    expect(await currentEmployeeId()).toBeNull()
    expect(api.sendCardless).not.toHaveBeenCalled()

    resetCurrentEmployeeIdForTests()
    api.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal', threads: [] } })
    api.sendCardless.mockRejectedValue(new Error('hub down'))
    await expect(announceChainStep(store, step(), 'x')).resolves.toBeNull()
  })

  it('a console that was briefly unreachable does not disable every later step', async () => {
    // The cache exists so the queue is read once, not once per step. Remembering a failure as the
    // answer would leave an app that started before the console was up recording nothing, forever.
    api.list.mockRejectedValueOnce(new Error('offline'))
    const store = access(chain([step()]))

    await expect(announceChainStep(store, step(), 'x')).resolves.toBeNull()

    api.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal', threads: [] } })
    await expect(announceChainStep(store, step(), 'x')).resolves.toBe('hth_step1')
    expect(api.sendCardless).toHaveBeenCalledTimes(1)
  })

  it('does not reopen a thread a step already has', async () => {
    const store = access(chain([step({ hubThreadId: 'hth_existing' })]))

    await expect(
      announceChainStep(store, step({ hubThreadId: 'hth_existing' }), 'x')
    ).resolves.toBe('hth_existing')
    expect(api.sendCardless).not.toHaveBeenCalled()
  })
})
