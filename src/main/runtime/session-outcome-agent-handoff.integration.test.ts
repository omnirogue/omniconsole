import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ChatAgentSend } from '../../shared/console-chat-agent-contract'
import type { PeerMessageThread } from '../../shared/peer-message-contract'
import type { SessionChainHandoffStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { installSessionOutcomeAgentReader } from './session-outcome-agent-evidence'
import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

it('keeps the exact employee agent through persisted completion, sends once, and waits for its real delivery receipt', async () => {
  const f = outcomeRuntimeFixture(() => ({ body: 'No successor agent should launch' }))
  try {
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'working',
      lastAssistantMessage: null,
      interactivePrompt: null,
      stateStartedAt: 1,
      updatedAt: Date.now()
    })
    f.write('original.html', '<h1>Exact original</h1>\r\n')
    const agent = {
      kind: 'agent' as const,
      id: 'recipient_session',
      employeeId: 'emp_uma',
      projectId: 'project',
      name: 'Uma agent',
      operationId: 'operation_agent',
      delivery: 'pending' as const
    }
    const messageId = `pm_${'a'.repeat(24)}`
    let sent: ChatAgentSend | undefined
    const thread: PeerMessageThread = {
      id: messageId,
      project_id: agent.projectId,
      sender_session_id: 'source_session',
      sender_employee_id: 'emp_sal',
      recipient_session_id: agent.id,
      recipient_employee_id: agent.employeeId,
      purpose: 'handoff',
      summary: 'Which result should we use?',
      communication_type: 'question',
      state: 'queued',
      created_at: 1,
      delivered_at: null,
      replied_at: null,
      resolved_at: null,
      expires_at: null,
      reply: null
    }
    const sendAgent = vi.fn(async (input: ChatAgentSend) => {
      sent = input
      return { messageId, recipientSessionId: agent.id, state: 'queued' }
    })
    const sendCardless = vi.fn()
    installSessionOutcomeHandoffTransport({
      principal: async () => 'company:person',
      hub: {
        upload: vi.fn(),
        send: vi.fn(),
        sendCardless,
        uploadThreadFile: vi.fn(),
        agentRecipients: async () => ({ agents: [agent] }),
        sendAgent,
        isRejected: () => false
      }
    })
    installSessionOutcomeAgentReader({
      getAgentMessage: async () => ({ ok: true, data: { thread } }),
      agentMessageFiles: async () => ({
        ok: true,
        data: {
          message_id: messageId,
          files: (sent?.attachments ?? []).map((file, index) => ({
            ...file,
            id: `pf_${String(index).padStart(32, '0')}`
          }))
        }
      })
    })
    const step: SessionChainHandoffStep = {
      id: 'handoff',
      kind: 'handoff',
      outcomeId: 'delivery',
      status: 'queued',
      handoff: {
        revision: 1,
        taskId: null,
        taskTitle: 'Agent handoff',
        sessionLabel: 'Source',
        recipients: [],
        agentRecipients: [agent],
        sourceConversationId: 'chat_source',
        communicationType: 'question',
        deliverables: { kind: 'files', paths: [join(f.workspace, 'original.html')] },
        includeSummary: false,
        note: thread.summary,
        savedAt: 1
      }
    }
    await f.service.commit(
      {
        id: 'agent_chain',
        workspacePath: f.workspace,
        worktreeId: 'folder:outcome',
        hostId: 'local',
        sourcePaneKey: 'source',
        sourceRowKey: 'row',
        auto: true,
        steps: [step],
        currentIndex: 0,
        state: 'waiting',
        createdAt: 1,
        updatedAt: 1
      },
      {
        expectedRevision: 0,
        source: 'user',
        outcomes: [
          {
            id: 'delivery',
            title: 'Hand off to the selected agent',
            finish: 'human-handoff',
            dependsOn: [],
            stepIds: ['handoff'],
            actions: [],
            conditions: [
              {
                id: 'delivery',
                kind: 'handoff',
                target: agent.name,
                recipientId: agent.employeeId,
                recipientSessionId: agent.id
              }
            ]
          }
        ]
      }
    )
    f.service.dispose()
    await f.service.tick()
    expect(sendAgent).not.toHaveBeenCalled()
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'done',
      lastAssistantMessage: 'Final',
      interactivePrompt: null,
      stateStartedAt: 2,
      updatedAt: Date.now()
    })
    await f.service.tick()
    await f.service.tick()
    expect(sendAgent).toHaveBeenCalledTimes(1)
    expect(sendCardless).not.toHaveBeenCalled()
    expect(sent).toMatchObject({
      recipientSessionId: agent.id,
      sourceConversationId: 'chat_source',
      communicationType: 'question',
      message: thread.summary
    })
    expect(Buffer.from(sent!.attachments[0]!.contentBase64, 'base64').toString()).toBe(
      '<h1>Exact original</h1>\r\n'
    )
    expect(sessionOutcomeProgress(f.service.get('agent_chain').outcomeSet!).satisfied).toBe(0)
    thread.state = 'delivered'
    thread.delivered_at = 3
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    try {
      await f.service.tick()
    } finally {
      clock.mockRestore()
    }
    expect(sessionOutcomeProgress(f.service.get('agent_chain').outcomeSet!).satisfied).toBe(1)
    await f.service.tick()
    expect(sendAgent).toHaveBeenCalledTimes(1)
    expect(f.launched).toEqual([])
  } finally {
    await f.dispose()
  }
})
