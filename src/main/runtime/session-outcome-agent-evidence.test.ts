import { expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { PeerMessageThread } from '../../shared/peer-message-contract'
import {
  installSessionOutcomeAgentReader,
  verifySessionOutcomeAgentDelivery
} from './session-outcome-agent-evidence'

it('requires actual agent delivery, the selected employee/session, and exact attachment receipts', async () => {
  const file = { id: `pf_${'a'.repeat(32)}`, name: 'report.md', sha256: 'b'.repeat(64), size: 42 }
  const agent = {
    kind: 'agent',
    id: 'target_session',
    employeeId: 'emp_uma',
    projectId: 'project',
    name: 'Uma agent',
    operationId: 'operation',
    delivery: 'sent',
    messageId: `pm_${'a'.repeat(24)}`
  }
  const chain = {
    steps: [
      {
        kind: 'handoff',
        handoff: {
          recipients: [],
          agentRecipients: [agent],
          note: 'Review the report',
          communicationType: 'request',
          files: [file]
        }
      }
    ]
  } as unknown as SessionChain
  const thread: PeerMessageThread = {
    id: agent.messageId,
    project_id: 'project',
    sender_session_id: 'source',
    recipient_session_id: agent.id,
    sender_employee_id: 'emp_sal',
    recipient_employee_id: agent.employeeId,
    purpose: 'handoff',
    summary: 'Review the report',
    communication_type: 'request',
    state: 'queued',
    created_at: 1,
    delivered_at: null,
    replied_at: null,
    resolved_at: null,
    expires_at: null,
    reply: null
  }
  const getAgentMessage = vi.fn(async () => ({ ok: true as const, data: { thread } }))
  const agentMessageFiles = vi.fn(async () => ({
    ok: true as const,
    data: { message_id: agent.messageId, files: [file] }
  }))
  installSessionOutcomeAgentReader({ getAgentMessage, agentMessageFiles })
  const condition = {
    id: 'delivery',
    kind: 'handoff' as const,
    target: 'Agent',
    recipientId: agent.employeeId,
    recipientSessionId: agent.id
  }
  expect(await verifySessionOutcomeAgentDelivery(condition, chain)).toMatchObject({
    verified: false,
    reason: expect.stringContaining('queued')
  })
  thread.state = 'delivered'
  thread.delivered_at = 2
  expect(await verifySessionOutcomeAgentDelivery(condition, chain)).toMatchObject({
    verified: true
  })
  thread.recipient_session_id = 'other_session'
  expect(await verifySessionOutcomeAgentDelivery(condition, chain)).toMatchObject({
    verified: false
  })
  thread.recipient_session_id = agent.id
  agentMessageFiles.mockResolvedValue({
    ok: true,
    data: { message_id: agent.messageId, files: [{ ...file, sha256: 'c'.repeat(64) }] }
  })
  expect(await verifySessionOutcomeAgentDelivery(condition, chain)).toMatchObject({
    verified: false,
    reason: expect.stringContaining('exact file versions')
  })
})
