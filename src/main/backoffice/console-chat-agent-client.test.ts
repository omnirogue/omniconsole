import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'
import { readChatAgentRecipients, sendChatAgentMessage } from './console-chat-agent-client'
import { chatAgentMessageClient as messages } from './console-chat-agent-messages'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const root = 'https://console.test/api/gtd/hub/api/session-peers'
const messageId = `pm_${'a'.repeat(24)}`
const replyId = `pm_${'b'.repeat(24)}`
const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
const bytes = Buffer.alloc(90_000, 7)
const attachment = capturedHandoffFile('plan.md', bytes)
const file = {
  id: `pf_${'c'.repeat(32)}`,
  name: attachment.name,
  size: attachment.size,
  sha256: attachment.sha256
}
const input = {
  recipientSessionId: 'session_uma',
  sourceConversationId: 'chat:abc_123',
  sourceLabel: 'Project chat',
  message: 'Review the attached plan.',
  communicationType: 'plan',
  attachments: [attachment],
  operationId: 'chat_send_0001'
}
const receipt = {
  id: messageId,
  recipient_session_id: input.recipientSessionId,
  state: 'queued',
  communication_type: 'plan'
}
const thread = {
  ...receipt,
  project_id: 'project_one',
  task_id: null,
  sender_session_id: 'pc_human',
  sender_employee_id: 'emp_sal',
  recipient_employee_id: 'emp_uma',
  purpose: 'question',
  summary: input.message,
  state: 'replied',
  created_at: 100,
  delivered_at: 101,
  replied_at: 102,
  resolved_at: null,
  expires_at: 86_500,
  reply: { id: replyId, summary: 'Here is the updated plan.', created_at: 102 }
}
const agent = {
  session_id: input.recipientSessionId,
  employee_id: 'emp_uma',
  employee_name: 'Uma',
  project_id: 'project_one',
  endpoint_kind: 'runtime',
  task_id: 'btk_plan',
  state: 'running',
  task_title: 'Plan',
  conversation_label: null,
  provider: 'codex'
}

function json(value: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(Response.json(value, { status }))
}

function requestBody(): unknown {
  return JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-chat-person',
      baseUrl: 'https://console.test',
      principal: 'sal@example.test',
      isCurrent
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('signed chat agent directory', () => {
  it('keeps exact session owners in authorized projects and omits unavailable endpoints', async () => {
    json({
      projects: [
        { id: 'project_one', name: 'One' },
        { id: 'project_two', name: 'Two' }
      ],
      truncated: false
    })
    json({
      agents: [
        agent,
        { ...agent, session_id: 'session_ended', state: 'ended' },
        {
          ...agent,
          session_id: 'pc_chat',
          endpoint_kind: 'logical_app',
          task_id: null,
          state: null
        },
        { ...agent, session_id: 'session_unbound', task_id: null }
      ],
      truncated: false
    })
    json({
      agents: [
        {
          ...agent,
          session_id: 'session_sal',
          employee_id: 'emp_sal',
          employee_name: 'Sal',
          project_id: 'project_two'
        }
      ]
    })
    expect(await readChatAgentRecipients()).toEqual({
      ok: true,
      data: {
        agents: [
          {
            id: 'session_uma',
            employeeId: 'emp_uma',
            projectId: 'project_one',
            name: 'Plan · Uma',
            projectName: 'One',
            provider: 'codex'
          },
          {
            id: 'session_sal',
            employeeId: 'emp_sal',
            projectId: 'project_two',
            name: 'Plan · Sal',
            projectName: 'Two',
            provider: 'codex'
          }
        ]
      }
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${root}/projects`,
      `${root}/directory?project_id=project_one`,
      `${root}/directory?project_id=project_two`
    ])
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: 'Bearer test-chat-person' }
      })
    }
  })

  it.each(['starting', 'running', 'awaiting_approval', 'resuming'])(
    'retains an enrolled runtime in state %s',
    async (state) => {
      json({ projects: [{ id: 'project_one', name: 'One' }] })
      json({ agents: [{ ...agent, state }] })
      expect(await readChatAgentRecipients()).toMatchObject({
        ok: true,
        data: { agents: [{ id: 'session_uma' }] }
      })
    }
  )

  it.each(['projects', 'agents'])('refuses a truncated %s directory', async (where) => {
    json({ projects: [{ id: 'project_one', name: 'One' }], truncated: where === 'projects' })
    if (where === 'agents') {
      json({ agents: [agent], truncated: true })
    }
    expect(await readChatAgentRecipients()).toMatchObject({
      ok: false,
      error: { code: 'directory_incomplete' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(where === 'projects' ? 1 : 2)
  })

  it('refuses a returned endpoint outside its requested project', async () => {
    json({ projects: [{ id: 'project_one', name: 'One' }] })
    json({ agents: [{ ...agent, project_id: 'another_project' }] })
    expect(await readChatAgentRecipients()).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('preserves a project membership refusal without an alternate directory lookup', async () => {
    json({ projects: [{ id: 'project_one', name: 'One' }] })
    json({ error: { code: 'peer_project_forbidden', message: 'Project access changed.' } }, 403)
    expect(await readChatAgentRecipients()).toMatchObject({
      ok: false,
      error: { code: 'peer_project_forbidden', status: 403 }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('signed chat to exact agent send', () => {
  it.each(['decision', 'request', 'question', 'plan', 'information'])(
    'sends %s with full text and pinned bytes over the existing route',
    async (communicationType) => {
      const text = `A full message\n${'content '.repeat(500)}\nhttps://drive.example.test/${'x'.repeat(600)}`
      json({
        message: { ...receipt, communication_type: communicationType },
        source_session_id: 'pc_human'
      })
      expect(await sendChatAgentMessage({ ...input, communicationType, message: text })).toEqual({
        ok: true,
        data: { messageId, recipientSessionId: 'session_uma', state: 'queued' }
      })
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        `${root}/messages`,
        expect.objectContaining({
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          headers: expect.objectContaining({ Authorization: 'Bearer test-chat-person' })
        })
      )
      expect(requestBody()).toEqual({
        recipient_session_id: 'session_uma',
        source_conversation_id: input.sourceConversationId,
        source_label: input.sourceLabel,
        summary: text,
        communication_type: communicationType,
        attachments: [{ filename: attachment.name, content_base64: attachment.contentBase64 }],
        idempotency_key: input.operationId
      })
    }
  )

  it.each([{ recipient_session_id: 'session_sal' }, { communication_type: 'question' }])(
    'refuses a receipt that changes the selected destination or type: %j',
    async (changed) => {
      json({ message: { ...receipt, ...changed } })
      expect(await sendChatAgentMessage(input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
  )

  it.each([
    { name: 'digest', changed: { sha256: 'd'.repeat(64) } },
    { name: 'size', changed: { size: attachment.size + 1 } },
    { name: 'base64', changed: { contentBase64: `${attachment.contentBase64}\n` } }
  ])('refuses attachment $name changes before transport', async ({ changed }) => {
    expect(
      await sendChatAgentMessage({ ...input, attachments: [{ ...attachment, ...changed }] })
    ).toMatchObject({
      ok: false,
      error: { code: 'file_changed' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'source ID', changed: { sourceConversationId: '/private/chat/path' } },
    { name: 'label UTF-8 size', changed: { sourceLabel: 'é'.repeat(81) } },
    { name: 'message UTF-8 size', changed: { message: '😀'.repeat(2049) } },
    { name: 'forged author', changed: { authorEmployeeId: 'emp_other' } }
  ])('refuses invalid $name before transport', async ({ changed }) => {
    expect(await sendChatAgentMessage({ ...input, ...changed })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('chat agent thread and private files', () => {
  it.each(['getAgentMessage', 'readAgentMessage'] as const)(
    '%s preserves the full returned reply using its exact message route',
    async (operation) => {
      const longReply = 'returned '.repeat(450)
      json({
        thread: { ...thread, reply: { ...thread.reply, summary: longReply } },
        messages: [],
        acknowledged: false
      })
      expect(await messages[operation]({ messageId })).toMatchObject({
        ok: true,
        data: { thread: { id: messageId, reply: { id: replyId, summary: longReply } } }
      })
      const [url, options] = fetchMock.mock.calls[0]
      expect(url).toBe(
        `${root}/messages/${messageId}${operation === 'readAgentMessage' ? '/read' : ''}`
      )
      expect(options?.method).toBe(operation === 'readAgentMessage' ? 'POST' : 'GET')
      if (operation === 'readAgentMessage') {
        expect(requestBody()).toEqual({})
      }
    }
  )

  it('resolves the exact original message and checks the resolved receipt', async () => {
    json({ message: { ...receipt, state: 'resolved' } })
    expect(await messages.resolveAgentMessage({ messageId })).toMatchObject({ ok: true })
    expect(fetchMock.mock.calls[0][0]).toBe(`${root}/messages/${messageId}/resolve`)
    expect(requestBody()).toEqual({})
    json({ message: { ...receipt, id: replyId, state: 'resolved' } })
    expect(await messages.resolveAgentMessage({ messageId })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('refuses a detail or manifest that names a different message', async () => {
    json({ thread: { ...thread, id: replyId } })
    expect(await messages.getAgentMessage({ messageId })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    json({ message_id: replyId, files: [file] })
    expect(await messages.agentMessageFiles({ messageId })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('downloads the exact private manifest version without following a supplied download URL', async () => {
    json({
      message_id: replyId,
      files: [{ ...file, download_url: 'https://other.test/private-file' }]
    })
    const manifest = await messages.agentMessageFiles({ messageId: replyId })
    expect(manifest).toEqual({ ok: true, data: { message_id: replyId, files: [file] } })
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    expect(await messages.downloadAgentFile({ messageId: replyId, file })).toEqual({
      ok: true,
      data: attachment
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${root}/messages/${replyId}/files`,
      `${root}/messages/${replyId}/files/${file.id}`
    ])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer test-chat-person' },
      credentials: 'omit',
      redirect: 'error'
    })
  })

  it.each([{ sha256: 'd'.repeat(64) }, { size: file.size + 1 }])(
    'rejects bytes that do not match the private file version: %j',
    async (changed) => {
      fetchMock.mockResolvedValueOnce(new Response(bytes))
      expect(
        await messages.downloadAgentFile({ messageId, file: { ...file, ...changed } })
      ).toMatchObject({ ok: false, error: { code: 'file_changed' } })
    }
  )

  it('drops private bytes when the signed account changes during fetch', async () => {
    fetchMock.mockImplementationOnce(async () => {
      isCurrent.mockReturnValue(false)
      return new Response(bytes)
    })
    expect(await messages.downloadAgentFile({ messageId, file })).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })

  it.each(['pm_short', `${messageId}/read`, '../another-message'])(
    'refuses malformed message ID %s before credentials or network',
    async (invalid) => {
      expect(await messages.getAgentMessage({ messageId: invalid })).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
      expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
})
