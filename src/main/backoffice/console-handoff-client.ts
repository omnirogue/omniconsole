import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  handoffId,
  handoffBind,
  handoffDetail,
  handoffQueue,
  handoffSend,
  handoffSendCardless,
  handoffForward,
  handoffDecide,
  handoffRespond,
  handoffReturn,
  handoffThreadUpload,
  handoffDigest,
  handoffThread,
  type ConsoleHandoffApi,
  type ExactHandoffFile
} from '../../shared/console-handoff-contract'
import {
  handoffPackageReferences,
  type HandoffPackageParts
} from '../../shared/console-handoff-disposition-reference'
import { taskRequest } from '../../shared/console-workflow-schemas'
import { readHandoffRecipients } from './console-handoff-recipients'
import { readChatAgentRecipients, sendChatAgentMessage } from './console-chat-agent-client'
import { chatAgentMessageClient } from './console-chat-agent-messages'
import { archiveHandoff, readArchivedHandoffs } from './console-handoff-archive'
import { requestConsoleWorkflow as request, validated, failure } from './console-workflow-transport'
import { withArtifactReviewSend as reviewed } from './handoff-artifact-review-send'

const ROOT = '/api/gtd/hub/api'
const receipt = (expected: {
  taskId?: string
  threadId?: string
  recipient?: string
  communicationType?: string
}) =>
  z
    .object({
      thread: handoffThread,
      forwarded_thread_id: handoffId.optional(),
      entry: z.object({ id: z.string() }).optional(),
      replayed: z.boolean().optional()
    })
    .refine(
      (value) =>
        (!expected.taskId || value.thread.board_task_id === expected.taskId) &&
        (!expected.threadId || value.thread.id === expected.threadId) &&
        (!expected.recipient || value.thread.recipient_employee_id === expected.recipient) &&
        (!expected.communicationType ||
          value.thread.communication_type === expected.communicationType)
    )
    .transform((value) => ({
      thread_id: value.thread.id,
      forwarded_thread_id: value.forwarded_thread_id,
      entry_id: value.entry?.id,
      replayed: value.replayed
    }))
const threadRequest = z.object({ threadId: handoffId }).strict()
const queueRequest = z
  .object({
    state: z.enum(['open', 'replied', 'resolved']).optional(),
    view: z.enum(['sent', 'archived']).optional(),
    // Why: the hub's sealed keyset position (unpadded base64url, at most 512); the strict
    // alphabet keeps it from carrying query syntax.
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,512}$/)
      .optional()
  })
  .strict()

function queuePath({ state, view, cursor }: z.infer<typeof queueRequest>): string {
  const query = new URLSearchParams()
  if (view) {
    query.set('view', view)
  } else if (!state) {
    query.set('view', 'attention')
  }
  if (state) {
    query.set('state', state)
  }
  if (cursor) {
    query.set('cursor', cursor)
  }
  return `${ROOT}/handoffs?${query.toString()}`
}
const pins = (input: { fileVersions: { path: string; sha256: string }[] }) => ({
  files: input.fileVersions.map((file) => file.path),
  file_versions: input.fileVersions
})

/** The hub has no field for these; they ride on the opening entry's references, or not at all. */
function openingReferences(input: HandoffPackageParts): { references?: unknown[] } {
  const references = handoffPackageReferences(input)
  return references.length ? { references } : {}
}

// Why: the relay's due_at pattern has no fractional seconds, which toISOString() always emits.
const dueAtWire = (value: string): string => value.replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, '')

/** The bytes the renderer captured still hash to the version it named; else the send is refused. */
function exactBytesMatch(file: ExactHandoffFile): boolean {
  const bytes = Buffer.from(file.contentBase64, 'base64')
  return (
    bytes.toString('base64') === file.contentBase64 &&
    bytes.length === file.size &&
    createHash('sha256').update(bytes).digest('hex') === file.sha256
  )
}
const FILE_CHANGED = 'The selected file bytes do not match their version. Select the file again.'

export const consoleHandoffClient: Omit<
  ConsoleHandoffApi,
  'readFile' | 'readAttachment' | 'uploadFile' | 'downloadFile' | 'prepareRoutes' | 'materialize'
> = {
  ...chatAgentMessageClient,
  agentRecipients: readChatAgentRecipients,
  sendAgent: sendChatAgentMessage,
  archive: archiveHandoff,
  list: (args = {}) =>
    validated(args, queueRequest, (input) =>
      input.view === 'archived'
        ? readArchivedHandoffs(queuePath(input))
        : request(queuePath(input), 'GET', handoffQueue)
    ),
  get: (args) =>
    validated(args, threadRequest, ({ threadId }) =>
      request(
        `${ROOT}/handoffs/${threadId}`,
        'GET',
        handoffDetail.refine((value) => value.thread.id === threadId)
      )
    ),
  markRead: (args) =>
    validated(args, threadRequest, ({ threadId }) =>
      request(
        `${ROOT}/handoffs/${threadId}/read`,
        'POST',
        handoffDetail.refine((value) => value.thread.id === threadId),
        {}
      )
    ),
  recipients: readHandoffRecipients,
  taskFiles: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        `${ROOT}/board/${taskId}/files`,
        'GET',
        z.object({
          files: z.array(
            z.object({
              rel: z.string(),
              size: z.number().nonnegative(),
              sha256: handoffDigest.nullable()
            })
          )
        })
      )
    ),
  send: (args) =>
    validated(
      args,
      handoffSend,
      reviewed((input) =>
        request(
          `${ROOT}/team/tasks/${input.taskId}/handoffs`,
          'POST',
          receipt({
            taskId: input.taskId,
            recipient: input.recipient,
            communicationType: input.communicationType
          }),
          {
            recipient_employee_id: input.recipient,
            kind: 'handoff',
            title: input.title,
            body: input.note,
            ...(input.action ? { action: input.action } : {}),
            ...(input.communicationType ? { communication_type: input.communicationType } : {}),
            ...openingReferences(input),
            ...pins(input),
            ...(input.dueAt ? { due_at: dueAtWire(input.dueAt) } : {}),
            idempotency_key: input.operationId
          },
          120_000
        )
      )
    ),
  sendCardless: (args) =>
    validated(
      args,
      handoffSendCardless,
      reviewed((input) => {
        if (!input.attachments.every(exactBytesMatch)) {
          return Promise.resolve(failure('file_changed', FILE_CHANGED))
        }
        return request(
          `${ROOT}/handoffs`,
          'POST',
          receipt({ recipient: input.recipient, communicationType: input.communicationType }),
          {
            recipient_employee_id: input.recipient,
            kind: 'handoff',
            title: input.title,
            body: input.note,
            ...(input.action ? { action: input.action } : {}),
            ...(input.communicationType ? { communication_type: input.communicationType } : {}),
            ...openingReferences(input),
            ...(input.dueAt ? { due_at: dueAtWire(input.dueAt) } : {}),
            idempotency_key: input.operationId,
            attachments: input.attachments.map((file) => ({
              filename: file.name,
              content_base64: file.contentBase64
            }))
          },
          120_000
        )
      })
    ),
  uploadThreadFile: (args) =>
    validated(args, handoffThreadUpload, (input) => {
      if (!exactBytesMatch(input.file)) {
        return Promise.resolve(failure('file_changed', FILE_CHANGED))
      }
      return request(
        `${ROOT}/handoffs/${input.threadId}/files/upload`,
        'POST',
        receipt({ threadId: input.threadId }),
        {
          filename: input.file.name,
          content_base64: input.file.contentBase64,
          note: input.note,
          idempotency_key: input.operationId
        },
        120_000
      )
    }),
  bindThread: (args) =>
    validated(args, handoffBind, (input) =>
      request(
        `${ROOT}/handoffs/${input.threadId}/bind`,
        'POST',
        // Why: the receipt must show the thread now on this card; anything else is not a bind.
        receipt({ threadId: input.threadId, taskId: input.taskId }),
        { board_task_id: input.taskId }
      )
    ),
  forward: (args) =>
    validated(args, handoffForward, (input) =>
      request(
        `${ROOT}/handoffs/${input.threadId}/forward`,
        'POST',
        receipt({ threadId: input.threadId }),
        {
          to: input.recipient,
          action: input.action,
          ...(input.communicationType ? { communication_type: input.communicationType } : {}),
          note: input.note,
          ...pins(input),
          ...(input.dueAt ? { due_at: dueAtWire(input.dueAt) } : {}),
          idempotency_key: input.operationId
        },
        120_000
      )
    ),
  review: (args) =>
    validated(args, handoffDecide, (input) =>
      request(
        `${ROOT}/handoffs/${input.threadId}/review`,
        'POST',
        receipt({ threadId: input.threadId }),
        {
          decision: input.decision,
          version_ids: input.versionIds,
          note: input.note,
          idempotency_key: input.operationId
        }
      )
    ),
  respond: (args) =>
    validated(args, handoffRespond, (input) =>
      request(
        `${ROOT}/handoffs/${input.threadId}/entries`,
        'POST',
        receipt({ threadId: input.threadId }),
        { kind: input.kind, body: input.note, idempotency_key: input.operationId }
      )
    ),
  returnFile: (args) =>
    validated(args, handoffReturn, (input) => {
      if (!exactBytesMatch(input.file)) {
        return Promise.resolve(failure('file_changed', FILE_CHANGED))
      }
      return request(
        `${ROOT}/handoffs/${input.threadId}/files/return`,
        'POST',
        receipt({ threadId: input.threadId }),
        {
          filename: input.file.name,
          content_base64: input.file.contentBase64,
          base_version_id: input.baseVersionId,
          note: input.note,
          idempotency_key: input.operationId
        },
        120_000
      )
    })
}
