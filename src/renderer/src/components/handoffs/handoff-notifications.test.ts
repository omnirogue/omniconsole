import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { HandoffQueue } from '../../../../shared/console-handoff-contract'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'
import { readPeerMessages } from '@/lib/peer-messages'
import {
  loadBackofficeWork,
  useBackofficeWorkStore
} from '../task-page/backoffice/backoffice-work-store'
import {
  createAgentReplyArrivalTracker,
  createHandoffArrivalTracker,
  createInboxMessageArrivalTracker,
  notifyAgentReplyArrivals
} from './handoff-notifications'
vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/peer-messages', () => ({ readPeerMessages: vi.fn() }))
const api = vi.hoisted(() => ({ list: vi.fn(), recipients: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
const dispatch = vi.fn()
const listTodo = vi.fn()
const listHumanActions = vi.fn()
const queue = (...ids: string[]) =>
  ({
    assignee: 'me',
    threads: ids.map((id) => ({ id, recipient_employee_id: 'me', state: 'open' }))
  }) as HandoffQueue

const originalId = `pm_${'a'.repeat(24)}`
const replyId = `pm_${'b'.repeat(24)}`
function message(overrides: Partial<PeerMessageThread> = {}): PeerMessageThread {
  return {
    id: originalId,
    project_id: 'prj_shared',
    task_id: null,
    sender_session_id: 'pc_chat',
    recipient_session_id: 'agent_uma',
    sender_employee_id: 'me',
    recipient_employee_id: 'uma',
    purpose: 'question',
    communication_type: 'plan',
    summary: 'Review the plan.\nExact bytes attached.',
    state: 'replied',
    created_at: 100,
    delivered_at: 101,
    replied_at: 102,
    resolved_at: null,
    expires_at: 86_500,
    reply: { id: replyId, summary: 'The updated plan is ready.', created_at: 102 },
    ...overrides
  }
}

function todo() {
  return {
    ok: true,
    baseUrl: 'https://console.test',
    employeeId: 'me',
    generatedAt: null,
    items: [],
    awaitingVerification: [],
    counts: null,
    nextCursor: null,
    truncated: false
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  dispatch.mockResolvedValue(undefined)
  listTodo.mockResolvedValue(todo())
  listHumanActions.mockResolvedValue({ ok: true, data: { ok: true, jobs: [] } })
  api.list.mockImplementation(async (args?: { view?: string }) => ({
    ok: true,
    data: { ...queue(), ...(args?.view ? { view: args.view } : {}) }
  }))
  api.recipients.mockResolvedValue({ ok: true, data: { employees: [] } })
  vi.mocked(readPeerMessages).mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      notifications: { dispatch },
      backoffice: { listTodo },
      consoleWorkflows: { listHumanActions }
    }
  })
  const idle = { phase: 'idle' } as const
  useBackofficeWorkStore.setState({
    scope: null,
    loadedAt: null,
    historyRequested: false,
    todo: idle,
    receivedOpen: idle,
    receivedHistory: idle,
    sent: idle,
    roster: idle,
    humanActions: idle,
    messages: idle
  })
})
afterEach(() => vi.unstubAllGlobals())

it('does not alert for the initial backlog or duplicate refreshes', () => {
  const track = createHandoffArrivalTracker()
  expect(track('account-a', queue('old'))).toEqual([])
  expect(track('account-a', queue('old', 'new')).map((row) => row.id)).toEqual(['new'])
  expect(track('account-a', queue('old', 'new'))).toEqual([])
})
it('resets the baseline on account changes and ignores another recipient', () => {
  const track = createHandoffArrivalTracker()
  track('account-a', queue('one'))
  expect(track('account-b', queue('two'))).toEqual([])
  const other = queue('other')
  other.threads[0]!.recipient_employee_id = 'someone-else'
  expect(track('account-b', other)).toEqual([])
})

describe('tagged agent reply arrivals', () => {
  it('baselines existing replies and emits each actual new reply ID once', () => {
    const track = createAgentReplyArrivalTracker()
    const old = message()
    const next = message({
      id: `pm_${'c'.repeat(24)}`,
      reply: { id: `pm_${'d'.repeat(24)}`, summary: 'Another answer.', created_at: 105 }
    })
    expect(track('scope', 'me', [old])).toEqual([])
    expect(track('scope', 'me', [old, next, next])).toEqual([next])
    expect(track('scope', 'me', [{ ...next, summary: 'Metadata changed.' }])).toEqual([])
    expect(track('scope', 'me', [])).toEqual([])
    expect(track('scope', 'me', [old, next])).toEqual([])
  })

  it('notifies when a known outgoing message receives its real reply', () => {
    const track = createAgentReplyArrivalTracker()
    expect(
      track('scope', 'me', [message({ state: 'queued', reply: null, replied_at: null })])
    ).toEqual([])
    expect(track('scope', 'me', [message()]).map((thread) => thread.reply?.id)).toEqual([replyId])
  })

  it('isolates account scope switches and establishes a fresh baseline when returning', () => {
    const track = createAgentReplyArrivalTracker()
    track('scope-a', 'me', [])
    expect(track('scope-b', 'me', [message()])).toEqual([])
    expect(track('scope-a', 'me', [message()])).toEqual([])
  })

  it('isolates an employee change even if the connection scope string is unchanged', () => {
    const track = createAgentReplyArrivalTracker()
    track('scope', 'me', [])
    const another = message({ sender_employee_id: 'uma', recipient_employee_id: 'me' })
    expect(track('scope', 'uma', [another])).toEqual([])
    expect(track('scope', 'me', [message()])).toEqual([])
  })

  it.each([
    { label: 'outgoing request', fields: { state: 'queued', reply: null } },
    {
      label: 'another employee',
      fields: { sender_employee_id: 'someone', recipient_employee_id: 'another' }
    },
    {
      label: 'another human to my agent',
      fields: { sender_employee_id: 'someone', recipient_employee_id: 'me' }
    },
    { label: 'legacy agent source', fields: { task_id: 'btk_legacy123' } },
    { label: 'omitted source task', fields: { task_id: undefined } },
    { label: 'missing reply receipt', fields: { reply: null } }
  ] satisfies { label: string; fields: Partial<PeerMessageThread> }[])(
    'ignores $label',
    ({ fields }) => {
      const track = createAgentReplyArrivalTracker()
      track('scope', 'me', [])
      expect(track('scope', 'me', [message(fields)])).toEqual([])
    }
  )

  it('does not backfill a resolved reply when a stale refresh later shows it as replied', () => {
    const track = createAgentReplyArrivalTracker()
    track('scope', 'me', [])
    expect(track('scope', 'me', [message({ state: 'resolved' })])).toEqual([])
    expect(track('scope', 'me', [message()])).toEqual([])
  })

  it('baselines without alerts when the viewer is unknown and when identity first arrives', () => {
    const track = createAgentReplyArrivalTracker()
    expect(track('scope', null, [message()])).toEqual([])
    expect(track('scope', 'me', [message()])).toEqual([])
  })

  it('uses the existing handoff dispatch and deduplicated in-app toast', () => {
    notifyAgentReplyArrivals('notify', 'me', [])
    notifyAgentReplyArrivals('notify', 'me', [message()])
    notifyAgentReplyArrivals('notify', 'me', [message()])
    expect(toast.message).toHaveBeenCalledExactlyOnceWith('Agent replied', {
      description: 'Review the plan.',
      id: `handoff:notify:reply:${replyId}`
    })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      source: 'handoff',
      notificationId: `handoff:notify:reply:${replyId}`,
      handoffTitle: 'Agent replied: Review the plan.'
    })
  })

  it('retains the in-app alert when native notification delivery fails', async () => {
    dispatch.mockRejectedValueOnce(new Error('Native delivery unavailable.'))
    notifyAgentReplyArrivals('native-fails', 'me', [])
    notifyAgentReplyArrivals('native-fails', 'me', [message()])
    await Promise.resolve()
    expect(toast.message).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })
})

describe('incoming human and agent messages', () => {
  it('notifies for the first new message after an empty baseline, once', () => {
    const track = createInboxMessageArrivalTracker()
    const incoming = message({
      sender_employee_id: 'other',
      recipient_employee_id: 'me',
      state: 'queued',
      reply: null
    })
    expect(track('incoming', 'me', [])).toEqual([])
    expect(track('incoming', 'me', [incoming])).toEqual([incoming])
    expect(track('incoming', 'me', [incoming])).toEqual([])
  })
  it('baselines on identity changes and ignores another recipient', () => {
    const track = createInboxMessageArrivalTracker()
    const incoming = message({ recipient_employee_id: 'me', state: 'queued', reply: null })
    track('incoming', 'me', [])
    expect(track('another-account', 'me', [incoming])).toEqual([])
    expect(
      track('another-account', 'me', [
        message({ id: 'pm_other', recipient_employee_id: 'someone-else' })
      ])
    ).toEqual([])
  })
})

describe('Work feed reply notification hook', () => {
  it('keeps ordinary handoff and agent reply alerts independent in the same refresh', async () => {
    await loadBackofficeWork('store-both')
    const received = queue('hth_received')
    received.threads[0]!.title = 'Review proposal'
    api.list.mockImplementation(async (args?: { view?: string }) => ({
      ok: true,
      data: args?.view === 'sent' ? { ...queue(), view: 'sent' } : received
    }))
    vi.mocked(readPeerMessages).mockResolvedValue([message()])
    await loadBackofficeWork('store-both', { force: true })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledWith({
      source: 'handoff',
      notificationId: 'handoff:store-both:hth_received',
      handoffTitle: 'Review proposal'
    })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'handoff',
        notificationId: `handoff:store-both:reply:${replyId}`
      })
    )
  })

  it('waits for identity, baselines old replies, then alerts on a later ready message feed', async () => {
    let releaseIdentity!: () => void
    const identity = new Promise<void>((resolve) => {
      releaseIdentity = resolve
    })
    listTodo.mockImplementationOnce(async () => {
      await identity
      return todo()
    })
    api.list.mockImplementation(async (args?: { view?: string }) => {
      await identity
      return { ok: true, data: { ...queue(), ...(args?.view ? { view: args.view } : {}) } }
    })
    vi.mocked(readPeerMessages).mockResolvedValue([message()])
    const first = loadBackofficeWork('store-ready')
    await vi.waitFor(() => expect(useBackofficeWorkStore.getState().messages.phase).toBe('ready'))
    expect(dispatch).not.toHaveBeenCalled()
    releaseIdentity()
    await first
    expect(dispatch).not.toHaveBeenCalled()
    vi.mocked(readPeerMessages).mockResolvedValue([
      message(),
      message({
        id: `pm_${'c'.repeat(24)}`,
        reply: { id: `pm_${'d'.repeat(24)}`, summary: 'New answer.', created_at: 106 }
      })
    ])
    await loadBackofficeWork('store-ready', { force: true })
    await loadBackofficeWork('store-ready', { force: true })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: 'handoff',
        notificationId: `handoff:store-ready:reply:pm_${'d'.repeat(24)}`
      })
    )
  })

  it('discards a late reply feed from a scope the user has left', async () => {
    await loadBackofficeWork('store-stale-a')
    let releaseMessages!: (messages: PeerMessageThread[]) => void
    vi.mocked(readPeerMessages).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseMessages = resolve
      })
    )
    const stale = loadBackofficeWork('store-stale-a', { force: true })
    vi.mocked(readPeerMessages).mockResolvedValue([message()])
    await loadBackofficeWork('store-stale-b')
    releaseMessages([message()])
    await stale
    expect(dispatch).not.toHaveBeenCalled()
    expect(toast.message).not.toHaveBeenCalled()
    expect(useBackofficeWorkStore.getState().scope).toBe('store-stale-b')
  })
})
