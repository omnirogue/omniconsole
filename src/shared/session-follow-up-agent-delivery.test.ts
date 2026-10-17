import { describe, expect, it, vi } from 'vitest'
import { deliverSessionFollowUp } from './session-follow-up-delivery'
import type { FollowUpDeliveryContext } from './session-follow-up-delivery-contract'
import { normalizeSessionFollowUpRule, type SessionFollowUpRule } from './session-follow-up-rule'

const agent = {
  kind: 'agent' as const,
  id: 'agent_session',
  employeeId: 'emp_uma',
  projectId: 'project',
  name: 'Uma’s agent',
  operationId: 'agent_operation',
  delivery: 'pending' as const
}
const receipt = { messageId: `pm_${'a'.repeat(24)}`, recipientSessionId: agent.id, state: 'queued' }
function fixture() {
  let current: SessionFollowUpRule = {
    revision: 1,
    taskId: null,
    taskTitle: 'Handoff',
    sessionLabel: 'Source',
    recipients: [],
    agentRecipients: [agent],
    sourceConversationId: 'chat_original',
    communicationType: 'question',
    deliverables: { kind: 'files', paths: [] },
    includeSummary: false,
    note: 'Which option should we use?',
    savedAt: 1,
    capturedAt: 2,
    files: []
  }
  const events: string[] = []
  const ctx: FollowUpDeliveryContext = {
    current: () => current,
    save: async (rule) => {
      current = normalizeSessionFollowUpRule(JSON.parse(JSON.stringify(rule)))!
      events.push(current.agentRecipients![0]!.delivery)
    },
    hub: {
      upload: vi.fn(),
      send: vi.fn(),
      sendCardless: vi.fn(),
      uploadThreadFile: vi.fn(),
      agentRecipients: vi.fn(async () => ({ agents: [agent] })),
      sendAgent: vi.fn(async () => {
        events.push('sendAgent')
        return receipt
      }),
      isRejected: () => false
    },
    bytes: vi.fn(),
    now: () => 3,
    sleep: vi.fn(async () => {})
  }
  return { ctx, events, saved: () => current }
}
describe('deferred delivery to the exact existing agent', () => {
  it('persists before the shared agent route, keeps its receipt, and never sends to the employee owner', async () => {
    const f = fixture()
    expect(await deliverSessionFollowUp(f.ctx)).toBe('delivered')
    expect(f.events).toEqual(['sending', 'sendAgent', 'sent'])
    expect(f.ctx.hub.sendAgent).toHaveBeenCalledWith({
      recipientSessionId: agent.id,
      sourceConversationId: 'chat_original',
      sourceLabel: 'Source',
      message: 'Which option should we use?',
      communicationType: 'question',
      attachments: [],
      operationId: agent.operationId
    })
    expect(f.ctx.hub.sendCardless).not.toHaveBeenCalled()
    expect(f.ctx.hub.send).not.toHaveBeenCalled()
    expect(f.saved().agentRecipients?.[0]).toMatchObject({
      delivery: 'sent',
      messageId: receipt.messageId
    })
    await deliverSessionFollowUp(f.ctx)
    expect(f.ctx.hub.sendAgent).toHaveBeenCalledTimes(1)
  })
  it('replays an uncertain answer using the same operation id and exact request', async () => {
    const f = fixture()
    vi.mocked(f.ctx.hub.sendAgent!)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(receipt)
    await deliverSessionFollowUp(f.ctx)
    const calls = vi.mocked(f.ctx.hub.sendAgent!).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(f.ctx.sleep).toHaveBeenCalledWith(2000)
  })
  it('refuses an unavailable endpoint or changed employee/project without falling back', async () => {
    const f = fixture()
    vi.mocked(f.ctx.hub.agentRecipients!).mockResolvedValue({
      agents: [{ ...agent, employeeId: 'emp_other' }]
    })
    await expect(deliverSessionFollowUp(f.ctx)).rejects.toThrow('no longer available')
    expect(f.ctx.hub.sendAgent).not.toHaveBeenCalled()
    expect(f.ctx.hub.sendCardless).not.toHaveBeenCalled()
    f.ctx.hub.sendAgent = undefined
    await expect(deliverSessionFollowUp(f.ctx)).rejects.toThrow('Update this execution host')
  })
  it('does not truncate an oversized UTF-8 message or send it through another route', async () => {
    const f = fixture()
    f.saved().note = 'é'.repeat(5000)
    await expect(deliverSessionFollowUp(f.ctx)).rejects.toThrow('8,192 UTF-8 bytes')
    expect(f.ctx.hub.sendAgent).not.toHaveBeenCalled()
  })
})
