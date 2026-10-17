// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendChatDelivery } from './chat-delivery-send'
import type { ChatDeliveryDraft } from '../../../../shared/chat-delivery'
import {
  readHandoffChatView,
  readPendingHandoff
} from '@/components/handoffs/handoff-request-memory'

const mocks = vi.hoisted(() => ({
  scope: 'account-A',
  me: vi.fn(),
  list: vi.fn(),
  recipients: vi.fn(),
  readAttachment: vi.fn(),
  sendCardless: vi.fn(),
  sendAgent: vi.fn(),
  uploadThreadFile: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ scope: mocks.scope }) } }))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (state: { scope: string }) => state.scope
}))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({ me: mocks.me })
}))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => mocks }))
vi.mock('@/lib/session-follow-up-io', () => ({
  createFollowUpHubIo: () => ({
    sendCardless: mocks.sendCardless,
    uploadThreadFile: mocks.uploadThreadFile
  })
}))

const person = { kind: 'person' as const, id: 'emp_uma', name: 'Uma Evans' }
const draft: ChatDeliveryDraft = {
  sourceConversationId: 'chat_source',
  sourceLabel: 'Chat',
  recipients: [person],
  communicationType: 'question',
  message: 'Sal, can you review this plan?',
  attachments: []
}
const file = { name: 'plan.md', sha256: 'a'.repeat(64), size: 3 }

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  mocks.scope = 'account-A'
  mocks.me.mockResolvedValue({
    ok: true,
    data: { ok: true, user: { employee_id: 'emp_sal_test' } }
  })
  mocks.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal_test', threads: [] } })
  mocks.recipients.mockResolvedValue({
    ok: true,
    data: { employees: [person, { id: 'emp_gamma', name: 'Sal' }] }
  })
  mocks.sendCardless.mockResolvedValue({ thread_id: 'hth_sent' })
  mocks.readAttachment.mockResolvedValue({ ok: true, data: { ...file, contentBase64: 'YWJj' } })
  mocks.sendAgent.mockResolvedValue({
    ok: true,
    data: { messageId: 'msg_sent', recipientSessionId: 'ses_codex', state: 'queued' }
  })
})

describe('chat uses the existing handoff delivery', () => {
  it('routes to the selected employee ID, independently of names in the message', async () => {
    await sendChatDelivery('account-A', 'chat:test', draft)
    expect(mocks.sendCardless).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: 'emp_uma',
        note: draft.message,
        communicationType: 'question',
        attachments: []
      })
    )
    expect(readPendingHandoff('account-A', 'chat:test')).toBeNull()
    expect(readHandoffChatView('account-A', 'chat:test').sent[0]).toMatchObject({
      recipients: [person],
      receipts: { 'person:emp_uma': { id: 'hth_sent', kind: 'person' } }
    })
  })
  it('stops the Gmail identity mismatch before saving or sending a new request', async () => {
    mocks.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal' } })
    await expect(sendChatDelivery('account-A', 'chat:test', draft)).rejects.toThrow('do not match')
    expect(mocks.sendCardless).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })
  it('keeps default Information messages in the recipient’s handoff feed', async () => {
    await sendChatDelivery('account-A', 'chat:information', {
      ...draft,
      communicationType: 'information'
    })
    const request = mocks.sendCardless.mock.calls[0][0]
    expect(request).toMatchObject({ recipient: 'emp_uma', communicationType: 'information' })
    // The legacy FYI action excludes a thread from the recipient's attention feed.
    expect(request).not.toHaveProperty('action')
  })
  it('preserves exact attachment versions and refuses a changed file', async () => {
    mocks.readAttachment.mockResolvedValue({
      ok: true,
      data: { ...file, sha256: 'b'.repeat(64), contentBase64: 'YWJj' }
    })
    await expect(
      sendChatDelivery('account-A', 'chat:test', {
        ...draft,
        attachments: [{ path: '/work/plan.md', file }]
      })
    ).rejects.toThrow('changed after')
    expect(mocks.sendCardless).not.toHaveBeenCalled()
  })
  it('retries only the unconfirmed recipient with the original operation ID', async () => {
    const two = {
      ...draft,
      recipients: [person, { kind: 'person' as const, id: 'emp_gamma', name: 'Sal' }]
    }
    mocks.sendCardless
      .mockResolvedValueOnce({ thread_id: 'hth_uma' })
      .mockRejectedValueOnce(new Error('Connection lost'))
    await expect(sendChatDelivery('account-A', 'chat:test', two)).rejects.toThrow('Connection lost')
    const operation = mocks.sendCardless.mock.calls[1][0].operationId
    await expect(
      sendChatDelivery('account-A', 'chat:test', { ...two, message: 'Changed' })
    ).rejects.toThrow('original message')
    await sendChatDelivery('account-A', 'chat:test', two)
    expect(mocks.sendCardless).toHaveBeenCalledTimes(3)
    expect(mocks.sendCardless.mock.calls[2][0]).toMatchObject({
      recipient: 'emp_gamma',
      operationId: operation
    })
  })
  it('does not send if the account changes while identity checks are pending', async () => {
    mocks.me.mockImplementation(async () => {
      mocks.scope = 'account-B'
      return { ok: true, data: { ok: true, user: { employee_id: 'emp_sal_test' } } }
    })
    await expect(sendChatDelivery('account-A', 'chat:test', draft)).rejects.toThrow(
      'account changed'
    )
    expect(mocks.sendCardless).not.toHaveBeenCalled()
  })
  it('sends an agent tag to the exact session through the existing peer adapter', async () => {
    await sendChatDelivery('account-A', 'chat:test', {
      ...draft,
      recipients: [
        {
          kind: 'agent',
          id: 'ses_codex',
          name: 'Codex',
          employeeId: 'emp_uma',
          projectId: 'prj_work'
        }
      ]
    })
    expect(mocks.sendAgent).toHaveBeenCalledWith(
      expect.objectContaining({ recipientSessionId: 'ses_codex', message: draft.message })
    )
    expect(mocks.sendCardless).not.toHaveBeenCalled()
  })
  it('refuses oversized UTF-8 agent text before freezing a retry or sending', async () => {
    await expect(
      sendChatDelivery('account-A', 'chat:test', {
        ...draft,
        message: '😀'.repeat(2049),
        recipients: [
          {
            kind: 'agent',
            id: 'ses_codex',
            name: 'Codex',
            employeeId: 'emp_uma',
            projectId: 'prj_work'
          }
        ]
      })
    ).rejects.toThrow('8 KB')
    expect(mocks.sendAgent).not.toHaveBeenCalled()
    expect(readPendingHandoff('account-A', 'chat:test')).toBeNull()
  })
})
