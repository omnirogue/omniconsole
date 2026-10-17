import { describe, expect, it } from 'vitest'
import { messageRow } from './backoffice-work-message-rows'
import { buildWorkViews } from './backoffice-work-views'
import { peerMessageThread, type PeerMessageThread } from './peer-message-contract'

const me = 'emp_sal'
const other = 'emp_uma'
const originalId = `pm_${'a'.repeat(24)}`
const replyId = `pm_${'b'.repeat(24)}`
const humanSession = `pc_${'c'.repeat(32)}`
const now = 1_789_200_000

function thread(overrides: Partial<PeerMessageThread> = {}): PeerMessageThread {
  return peerMessageThread.parse({
    id: originalId,
    project_id: 'prj_shared',
    // PeerStore copies the sender endpoint's task, never the recipient agent's task.
    task_id: null,
    sender_session_id: humanSession,
    recipient_session_id: 'agent_sal',
    sender_employee_id: me,
    recipient_employee_id: me,
    purpose: 'question',
    communication_type: 'plan',
    attachment_count: 1,
    summary: 'Review this plan.\nThe exact file is attached.',
    state: 'queued',
    created_at: now,
    delivered_at: null,
    replied_at: null,
    resolved_at: null,
    expires_at: now + 86_400,
    reply: null,
    ...overrides
  })
}

function views(message: PeerMessageThread, employeeId: string | null = me) {
  return buildWorkViews({
    employeeId,
    todo: { items: [], awaitingVerification: [], truncated: false },
    received: { open: [], history: [] },
    sent: [],
    followUps: [],
    humanJobs: [],
    messages: [message]
  })
}

function answered(overrides: Partial<PeerMessageThread> = {}): PeerMessageThread {
  return thread({
    state: 'replied',
    delivered_at: now + 10,
    replied_at: now + 20,
    reply: { id: replyId, summary: 'The updated plan is ready.', created_at: now + 20 },
    ...overrides
  })
}

describe('human chat peer message filing', () => {
  it.each(['queued', 'delivered'] as const)(
    'files my chat to my own agent as Waiting For when %s',
    (state) => {
      const message = thread({ state, delivered_at: state === 'delivered' ? now + 10 : null })
      expect(messageRow(message, me)).toMatchObject({
        direction: 'sent',
        taskId: null,
        needsYou: false,
        waitingFor: true,
        nextActor: { kind: 'person', id: me },
        actionLabel: 'plan'
      })
      const result = views(message)
      expect(result.needsYou).toEqual([])
      expect(result.waitingFor.map((row) => row.key)).toEqual([`message:${originalId}`])
      expect(result.counts).toEqual({ needsYou: 0, waitingFor: 1, decisions: 0 })
    }
  )

  it('files my chat to another employee’s agent as Waiting For', () => {
    const result = views(
      thread({ recipient_employee_id: other, recipient_session_id: 'agent_uma' })
    )
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor[0]).toMatchObject({
      direction: 'sent',
      needsYou: false,
      waitingFor: true,
      nextActor: { kind: 'person', id: other }
    })
  })

  it.each(['queued', 'delivered'] as const)(
    'files another human’s chat to my agent in Needs You when %s',
    (state) => {
      const message = thread({
        sender_employee_id: other,
        sender_session_id: `pc_${'d'.repeat(32)}`,
        state,
        delivered_at: state === 'delivered' ? now + 10 : null
      })
      expect(messageRow(message, me)).toMatchObject({
        direction: 'received',
        taskId: null,
        needsYou: true,
        waitingFor: false,
        kind: 'reply',
        nextActor: { kind: 'me' }
      })
      const result = views(message)
      expect(result.needsYou.map((row) => row.key)).toEqual([`message:${originalId}`])
      expect(result.waitingFor).toEqual([])
      expect(result.counts.needsYou).toBe(1)
    }
  )

  it.each([me, other])(
    'returns the answer from an agent owned by %s to my human chat in Needs You',
    (owner) => {
      const message = answered({
        recipient_employee_id: owner,
        recipient_session_id: `agent_${owner}`
      })
      expect(messageRow(message, me)).toMatchObject({
        direction: 'sent',
        taskId: null,
        needsYou: true,
        waitingFor: false,
        kind: 'reply',
        nextActor: { kind: 'me' },
        updatedAt: new Date((now + 20) * 1000).toISOString()
      })
      const result = views(message)
      expect(result.needsYou.map((row) => row.key)).toEqual([`message:${originalId}`])
      expect(result.needsYou[0]?.message?.reply?.id).toBe(replyId)
      expect(result.waitingFor).toEqual([])
    }
  )

  it('keeps a returned reply in Needs You until the original requester resolves it', () => {
    const message = answered()
    expect(views(message).needsYou).toHaveLength(1)
    const resolved = views({ ...message, state: 'resolved', resolved_at: now + 30 })
    expect(resolved.needsYou).toEqual([])
    expect(resolved.waitingFor).toEqual([])
    expect(resolved.all[0]).toMatchObject({
      state: 'resolved',
      updatedAt: new Date((now + 30) * 1000).toISOString()
    })
  })

  it('does not leave the recipient waiting after its agent has answered another human', () => {
    const result = views(answered({ sender_employee_id: other, sender_session_id: 'pc_uma' }))
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor).toEqual([])
    expect(result.all[0]).toMatchObject({
      direction: 'received',
      needsYou: false,
      waitingFor: false
    })
  })

  it.each(['queued', 'delivered', 'replied', 'resolved', 'expired'] as const)(
    'does not file an unrelated admin-visible %s message as my obligation',
    (state) => {
      const message = thread({
        sender_employee_id: other,
        recipient_employee_id: 'emp_third',
        state
      })
      const row = messageRow(message, me)
      expect(row).toMatchObject({ needsYou: false, waitingFor: false })
      expect(row.direction).toBeUndefined()
      const result = views(message)
      expect(result.needsYou).toEqual([])
      expect(result.waitingFor).toEqual([])
      expect(result.all).toHaveLength(1)
    }
  )

  it('requires a known viewer before assigning either list', () => {
    const result = views(answered(), null)
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor).toEqual([])
    expect(result.all[0]).toMatchObject({ needsYou: false, waitingFor: false })
    expect(result.all[0]?.direction).toBeUndefined()
    expect(result.gaps).toContain('viewer-unknown')
  })

  it('keeps an expired human send in history without an active wait', () => {
    const result = views(thread({ state: 'expired' }))
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor).toEqual([])
    expect(result.all[0]).toMatchObject({ state: 'expired', direction: 'sent' })
  })
})

describe('legacy peer message filing', () => {
  it.each(['btk_legacy123', undefined])(
    'keeps incoming legacy messages with task %s in All',
    (taskId) => {
      const message = thread({
        sender_employee_id: other,
        task_id: taskId,
        communication_type: undefined
      })
      expect(messageRow(message, me)).toMatchObject({
        needsYou: true,
        waitingFor: false,
        direction: 'received',
        actionLabel: 'question'
      })
      const result = views(message)
      expect(result.needsYou).toEqual([])
      expect(result.waitingFor).toEqual([])
      expect(result.all).toHaveLength(1)
    }
  )

  it('preserves the legacy task link and outgoing wait for another employee', () => {
    const result = views(
      thread({
        task_id: 'btk_legacy123',
        sender_session_id: 'agent_sal',
        recipient_session_id: 'agent_uma',
        recipient_employee_id: other
      })
    )
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor[0]).toMatchObject({
      taskId: 'btk_legacy123',
      direction: 'sent',
      nextActor: { kind: 'person', id: other }
    })
  })

  it('does not infer human chat from matching employee IDs or a session prefix without a null task', () => {
    const message = thread({ task_id: undefined })
    expect(messageRow(message, me)).toMatchObject({
      direction: 'received',
      needsYou: true,
      waitingFor: false
    })
    const result = views(message)
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor).toEqual([])
  })

  it('keeps an answer to a legacy agent-originated message in All', () => {
    const result = views(
      answered({
        task_id: 'btk_legacy123',
        sender_session_id: 'agent_sal',
        recipient_employee_id: other
      })
    )
    expect(result.needsYou).toEqual([])
    expect(result.waitingFor).toEqual([])
    expect(result.all[0]?.message?.reply?.id).toBe(replyId)
  })
})
