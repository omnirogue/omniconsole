vi.mock('../next-action/up-next-surface', () => ({ upNextSurface: () => ({}) }))
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import { createNextStepSendMemory, sendNextStep } from './next-step-send'

const api = vi.hoisted(() => ({
  taskFiles: vi.fn(),
  send: vi.fn(),
  forward: vi.fn(),
  respond: vi.fn()
}))
// Why: the card a handoff lands on is filed by the estate's folders; this suite is about
// what Send does with the card, so the place is driven from here.
const filing = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({
    filing: { companyId: 'cmp_click', unitId: 'dom_ads', goalId: 'cgl_q4' }
  }))
}))
vi.mock('./next-step-card-filing', () => ({ resolveNextStepCardFiling: filing.resolve }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
const chains = vi.hoisted(() => ({ createCompiledSessionChain: vi.fn(() => ({ id: 'chn_1' })) }))
vi.mock('@/lib/session-chain-runner', () => ({
  createCompiledSessionChain: chains.createCompiledSessionChain,
  findSessionChainForRow: () => null
}))
vi.mock('@/lib/session-follow-up-commands', () => ({ sessionFollowUpRefusal: () => null }))
const store = vi.hoisted(() => ({
  settings: {} as { experimentalCardlessHandoffs?: boolean },
  worktree: undefined as
    | { path: string; linkedWorkItem?: { hubTaskId?: string; title?: string } }
    | undefined,
  openModal: vi.fn(),
  updateWorktreeMeta: vi.fn(async () => undefined)
}))
const waitLater = vi.hoisted(() => ({ setReturned: vi.fn() }))
vi.mock('@/store/wait-later-store', () => ({
  useWaitLater: { getState: () => ({ setReturned: waitLater.setReturned }) }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: store.settings,
      openModal: store.openModal,
      getKnownWorktreeById: () => store.worktree,
      updateWorktreeMeta: store.updateWorktreeMeta
    })
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const item = { task_id: 'btk_1', title: 'Card', state_revision: 2 }
const draft: NextStepDraft = {
  end: 'me',
  placement: null,
  recipients: [
    { kind: 'person', key: 'p1', id: 'emp_uma', name: 'Uma' },
    { kind: 'person', key: 'p2', id: 'emp_sal', name: 'Sal' }
  ],
  note: 'Please check.',
  after: [],
  handoff: { task: { id: 'btk_1', title: 'Card' }, deliverables: null, includeSummary: true }
}
const agentDraft: NextStepDraft = {
  ...draft,
  recipients: [
    {
      kind: 'agent',
      key: 'a1',
      agent: 'codex',
      presetId: 'review',
      instructions: 'Review the handed-off files.',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      rounds: 1
    }
  ]
}
const detail: HandoffDetail = {
  thread: {
    id: 'hth_one',
    board_task_id: 'btk_thread',
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_uma',
    title: 'Review the task files',
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-12T09:00:00Z'
  },
  files: [],
  reviews: [],
  entries: []
}
const continueTask = vi.fn()

beforeEach(() => {
  // Why: a test that made the place unknown must not leak that into the next one.
  filing.resolve.mockReset().mockResolvedValue({
    filing: { companyId: 'cmp_click', unitId: 'dom_ads', goalId: 'cgl_q4' }
  })
  api.taskFiles.mockReset().mockResolvedValue({ ok: true, data: { files: [] } })
  api.send.mockReset()
  api.forward.mockReset()
  api.respond.mockReset()
  store.openModal.mockClear()
  store.settings = {}
  continueTask.mockReset()
  Object.assign(window, { api: { consoleLocalExecution: { continueTask } } })
})

describe('sendNextStep on a card', () => {
  it('refuses unsupported parallel task recipients before sending anyone', async () => {
    store.openModal.mockClear()
    const recipients = [
      ...draft.recipients,
      ...(['claude', 'codex'] as const).map((agent) => ({
        kind: 'agent' as const,
        key: agent,
        agent,
        instructions: 'Review the work.',
        presetId: null,
        rounds: 1
      }))
    ]
    const result = await sendNextStep({ kind: 'card', item }, { ...draft, recipients })
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('Choose one agent')
    expect(api.send).not.toHaveBeenCalled()
    expect(store.openModal).not.toHaveBeenCalled()
  })

  it('refuses a card draft that still carries later steps, an ending or a computer', async () => {
    const result = await sendNextStep(
      { kind: 'card', item },
      {
        ...draft,
        recipients: [draft.recipients[0]!],
        end: 'done',
        after: [{ kind: 'person', key: 'p3', id: 'emp_x', name: 'X', level: 2 }]
      }
    )
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('only be set from a running conversation')
    })
    expect(api.send).not.toHaveBeenCalled()
  })

  it('sends to each person with no requested action, then says who got it', async () => {
    api.send.mockResolvedValue({ ok: true, data: { thread_id: 'hth_1' } })
    const result = await sendNextStep({ kind: 'card', item }, draft, createNextStepSendMemory())
    expect(result).toEqual({ ok: true, message: 'Sent to Uma, Sal.' })
    expect(api.send).toHaveBeenCalledTimes(2)
    const first = api.send.mock.calls[0]![0]
    expect(first).toMatchObject({ taskId: 'btk_1', recipient: 'emp_uma', note: 'Please check.' })
    expect(first.action).toBeUndefined()
  })

  it('after a partial failure, Send again reuses the key and skips who already received it', async () => {
    const memory = createNextStepSendMemory()
    api.send
      .mockResolvedValueOnce({ ok: true, data: { thread_id: 'hth_1' } })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, data: { thread_id: 'hth_2' } })
    const first = await sendNextStep({ kind: 'card', item }, draft, memory)
    expect(first).toEqual({ ok: false, message: 'Sent to Uma. Sending to Sal failed: timeout' })
    const second = await sendNextStep({ kind: 'card', item }, draft, memory)
    expect(second).toEqual({ ok: true, message: 'Sent to Sal.' })
    // Why: Uma was never sent to twice, and Sal's retry carried the same idempotency key.
    const recipients = api.send.mock.calls.map((call) => call[0].recipient)
    expect(recipients).toEqual(['emp_uma', 'emp_sal', 'emp_sal'])
    expect(api.send.mock.calls[1]![0].operationId).toBe(api.send.mock.calls[2]![0].operationId)
  })

  it('refuses more than twenty people before anything leaves', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      kind: 'person' as const,
      key: `p${index}`,
      id: `emp_${index}`,
      name: `P${index}`
    }))
    const result = await sendNextStep({ kind: 'card', item }, { ...draft, recipients: many })
    expect(result).toMatchObject({ ok: false, problems: [{ kind: 'too-many-people' }] })
    expect(api.send).not.toHaveBeenCalled()
  })
})

describe('sendNextStep on a session', () => {
  const session: SidebarSession = {
    rowKey: 'row',
    sessionKey: 's',
    worktreeId: 'folder:f1',
    hostId: 'local',
    tabId: 'tab',
    paneKey: 'tab:leaf',
    kind: 'terminal',
    label: 'Build the login page',
    workspaceLabel: 'W',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
  const toUma: NextStepDraft = {
    end: 'me',
    placement: null,
    recipients: [{ kind: 'person', key: 'p1', id: 'emp_uma', name: 'Uma' }],
    note: 'Please check the result.\nSecond line.',
    after: [],
    handoff: { task: null, deliverables: null, includeSummary: true }
  }

  beforeEach(() => {
    store.settings = { experimentalCardlessHandoffs: false }
    store.worktree = { path: '/work/f1' }
    store.updateWorktreeMeta.mockClear()
    chains.createCompiledSessionChain.mockClear()
  })

  it.each(['local', 'ssh:server', 'runtime:env'] as const)(
    'refuses legacy renderer chain admission on %s before any card or chain write',
    async (placement) => {
      const createTask = vi.fn()
      Object.assign(window, { api: { backoffice: { createTask } } })
      const result = await sendNextStep({ kind: 'session', session }, { ...toUma, placement })
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('legacy_renderer_chain_creation_refused')
      })
      expect(createTask).not.toHaveBeenCalled()
      expect(chains.createCompiledSessionChain).not.toHaveBeenCalled()
    }
  )
})

describe('sendNextStep task continuation', () => {
  it.each(['claude', 'codex', 'grok'] as const)(
    'carries the card and selected %s preferences into continuation without starting work',
    async (agent) => {
      const memory = createNextStepSendMemory()
      const recipients = agentDraft.recipients.map((recipient) => ({ ...recipient, agent }))
      const result = await sendNextStep(
        { kind: 'card', item },
        { ...agentDraft, recipients },
        memory
      )
      expect(result.ok).toBe(true)
      expect(store.openModal).toHaveBeenCalledExactlyOnceWith('task-continuation', {
        taskId: 'btk_1',
        title: 'Card',
        agent,
        model: 'gpt-6-astra',
        effort: 'xhigh',
        instruction: expect.stringContaining('Chosen action: Review: Review the handed-off files.'),
        operationId: expect.any(String)
      })
      const operationId = store.openModal.mock.calls[0]![1].operationId
      expect(operationId).toMatch(/^[A-Za-z0-9_-]{8,160}$/)
      expect(memory.operationIds.get('a1')).toBe(operationId)
      expect(continueTask).not.toHaveBeenCalled()
    }
  )

  it('keeps the source thread and its task identity through continuation', async () => {
    const memory = createNextStepSendMemory()
    memory.operationIds.set('a1', 'ns_thread_continuation')
    const result = await sendNextStep(
      { kind: 'thread', detail, viewer: 'emp_uma' },
      agentDraft,
      memory
    )
    expect(result.ok).toBe(true)
    expect(store.openModal).toHaveBeenCalledExactlyOnceWith('task-continuation', {
      taskId: 'btk_thread',
      threadId: 'hth_one',
      title: 'Review the task files',
      agent: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      instruction: expect.stringContaining('Chosen action: Review: Review the handed-off files.'),
      operationId: 'ns_thread_continuation'
    })
    expect(api.send).not.toHaveBeenCalled()
    expect(api.forward).not.toHaveBeenCalled()
    expect(api.respond).not.toHaveBeenCalled()
    expect(continueTask).not.toHaveBeenCalled()
  })

  it('reuses the operation ID when reopened and assigns a new ID to another recipient', async () => {
    const memory = createNextStepSendMemory()
    const subject = { kind: 'card' as const, item }
    await sendNextStep(subject, agentDraft, memory)
    await sendNextStep(subject, agentDraft, memory)
    await sendNextStep(
      subject,
      {
        ...agentDraft,
        recipients: agentDraft.recipients.map((agent) => ({ ...agent, key: 'a2' }))
      },
      memory
    )
    const operationIds = store.openModal.mock.calls.map(([, payload]) => payload.operationId)
    expect(operationIds).toHaveLength(3)
    expect(operationIds[0]).toBeTruthy()
    expect(operationIds[1]).toBe(operationIds[0])
    expect(operationIds[2]).not.toBe(operationIds[0])
    expect(memory.operationIds.get('a2')).toBe(operationIds[2])
  })

  it.each([{}, { consoleLocalExecution: {} }])(
    'refuses task-bound sends when the continuation capability is absent: %j',
    async (unavailableApi) => {
      Object.assign(window, { api: unavailableApi })
      expect(await sendNextStep({ kind: 'card', item }, agentDraft)).toMatchObject({ ok: false })
      expect(
        await sendNextStep({ kind: 'thread', detail, viewer: 'emp_uma' }, agentDraft)
      ).toMatchObject({ ok: false })
      expect(store.openModal).not.toHaveBeenCalled()
      expect(continueTask).not.toHaveBeenCalled()
    }
  )

  it.each([true, false])(
    'keeps a taskless thread in the workspace composer with continuation available=%s',
    async (available) => {
      Object.assign(window, {
        api: available ? { consoleLocalExecution: { continueTask } } : {}
      })
      const result = await sendNextStep(
        {
          kind: 'thread',
          detail: { ...detail, thread: { ...detail.thread, board_task_id: null } },
          viewer: 'emp_uma'
        },
        agentDraft
      )
      expect(result.ok).toBe(true)
      expect(store.openModal).toHaveBeenCalledExactlyOnceWith(
        'new-workspace-composer',
        expect.objectContaining({
          initialAgent: 'codex',
          launchOptions: {
            preferences: { model: 'gpt-6-astra', effort: 'xhigh' },
            submitPrompt: true,
            chatBypass: true
          },
          prefilledNote: expect.stringContaining('Review: Review the handed-off files.')
        })
      )
      expect(store.openModal.mock.calls[0]![1].linkedWorkItem.hubTaskId).toBeUndefined()
      expect(continueTask).not.toHaveBeenCalled()
    }
  )
})
