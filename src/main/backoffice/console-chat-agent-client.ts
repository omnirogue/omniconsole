import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  chatAgentSend,
  type ChatAgentRecipient,
  type ChatAgentReceipt
} from '../../shared/console-chat-agent-contract'
import { failure, requestConsoleWorkflow as request, validated } from './console-workflow-transport'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'

const ROOT = '/api/gtd/hub/api/session-peers'
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const directory = z.object({
  agents: z.array(
    z.object({
      session_id: id,
      employee_id: id,
      project_id: id,
      employee_name: z.string().optional(),
      conversation_label: z.string().nullable().optional(),
      task_title: z.string().nullable().optional(),
      provider: z.string().nullable().optional(),
      endpoint_kind: z.string(),
      state: z.string().nullable(),
      task_id: z.string().nullable()
    })
  ),
  truncated: z.boolean().optional()
})

export async function readChatAgentRecipients(): Promise<
  ConsoleWorkflowResult<{ agents: ChatAgentRecipient[] }>
> {
  const projects = await request(
    `${ROOT}/projects`,
    'GET',
    z.object({
      projects: z.array(z.object({ id, name: z.string() })),
      truncated: z.boolean().optional()
    })
  )
  if (!projects.ok) {
    return projects
  }
  if (projects.data.truncated) {
    return failure(
      'directory_incomplete',
      'The project directory is incomplete. Refresh before choosing an agent.'
    )
  }
  const agents: ChatAgentRecipient[] = []
  for (const project of projects.data.projects) {
    const result = await request(
      `${ROOT}/directory?project_id=${encodeURIComponent(project.id)}`,
      'GET',
      directory
    )
    if (!result.ok) {
      return result
    }
    if (result.data.truncated) {
      return failure(
        'directory_incomplete',
        'The agent directory is incomplete. Narrow the project before sending.'
      )
    }
    for (const agent of result.data.agents) {
      if (agent.project_id !== project.id) {
        return failure('invalid_response', 'The agent directory returned another project.')
      }
      if (
        !agent.task_id ||
        agent.endpoint_kind !== 'runtime' ||
        !['starting', 'running', 'awaiting_approval', 'resuming'].includes(agent.state ?? '')
      ) {
        continue
      }
      agents.push({
        id: agent.session_id,
        employeeId: agent.employee_id,
        projectId: project.id,
        name: [
          agent.conversation_label || agent.task_title || agent.provider || agent.session_id,
          agent.employee_name
        ]
          .filter(Boolean)
          .join(' · '),
        projectName: project.name,
        ...(agent.provider ? { provider: agent.provider } : {})
      })
    }
  }
  return { ok: true, data: { agents } }
}

export const sendChatAgentMessage = (
  args: unknown
): Promise<ConsoleWorkflowResult<ChatAgentReceipt>> =>
  validated(args, chatAgentSend, (input): Promise<ConsoleWorkflowResult<ChatAgentReceipt>> => {
    if (
      input.attachments.some((file) => {
        const bytes = Buffer.from(file.contentBase64, 'base64')
        return (
          bytes.toString('base64') !== file.contentBase64 ||
          bytes.length !== file.size ||
          createHash('sha256').update(bytes).digest('hex') !== file.sha256
        )
      })
    ) {
      return Promise.resolve(
        failure('file_changed', 'The attachment bytes no longer match the selected version.')
      )
    }
    return request(
      `${ROOT}/messages`,
      'POST',
      z
        .object({
          message: z.object({
            id: z.string().regex(/^pm_[a-f0-9]{24}$/),
            recipient_session_id: id,
            state: z.string(),
            communication_type: z.string().nullable().optional()
          })
        })
        .refine(
          ({ message }) =>
            message.recipient_session_id === input.recipientSessionId &&
            message.communication_type === input.communicationType
        )
        .transform(({ message }) => ({
          messageId: message.id,
          recipientSessionId: message.recipient_session_id,
          state: message.state
        })),
      {
        recipient_session_id: input.recipientSessionId,
        source_conversation_id: input.sourceConversationId,
        source_label: input.sourceLabel,
        summary: input.message,
        communication_type: input.communicationType,
        attachments: input.attachments.map((file) => ({
          filename: file.name,
          content_base64: file.contentBase64
        })),
        idempotency_key: input.operationId
      },
      120_000
    )
  })
