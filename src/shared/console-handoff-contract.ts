import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'
import { taskId } from './console-workflow-schemas'
import { consoleJiraWorkRef, handoffTaskProposal } from './console-jira-work-contract'
import { communicationType } from './communication-type'
import { handoffDisposition } from './console-handoff-disposition-reference'
import { handoffReview, handoffVersionId, withReviewWords } from './console-handoff-review'
import { handoffArtifactReview } from './handoff-artifact-review'

export { handoffVersionId }
import type { PeerMessageArchiveRequest, PeerMessageArchiveReceipt } from './peer-message-contract'
import type {
  ChatAgentReceipt,
  ChatAgentRecipient,
  ChatAgentSend,
  ChatAgentMessageRequest,
  ChatAgentMessageDetail,
  ChatAgentFile
} from './console-chat-agent-contract'

import type {
  HandoffRoutePreparation,
  HandoffRoutePreparationRequest
} from './handoff-route-preparation'

export const HANDOFF_FILE_MAX_BYTES = 10 * 1024 * 1024
export const HANDOFF_THREAD_FILE_MAX_BYTES = 25 * 1024 * 1024
export const handoffId = z.string().regex(/^hth_[A-Za-z0-9_-]{1,128}$/)
export const handoffDigest = z.string().regex(/^[a-f0-9]{64}$/)
export const handoffAction = z.enum(['review', 'approve', 'decide', 'edit', 'fyi'])
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,160}$/)
const note = z.string().trim().min(1).max(8192)
const path = z.string().min(1).max(4096)
export const handoffFilePin = z.object({ path, sha256: handoffDigest }).strict()
export const handoffFile = z.object({
  id: handoffVersionId,
  path,
  name: z.string(),
  sha256: handoffDigest,
  size: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  parent_version_id: handoffVersionId.nullable(),
  current: z.boolean(),
  available: z.boolean()
})
export const handoffThread = z.object({
  id: handoffId,
  // Why: a hub with card-less handoffs serves threads that belong to no card; a reader tolerates null.
  board_task_id: taskId.nullable(),
  task_ref: consoleJiraWorkRef.nullable().optional(),
  author_employee_id: z.string(),
  recipient_employee_id: z.string(),
  title: z.string(),
  state: z.enum(['open', 'replied', 'resolved']),
  action: handoffAction.nullable(),
  communication_type: communicationType.nullable().optional(),
  due_at: z.string().nullable(),
  parent_thread_id: handoffId.nullable(),
  delivery_id: z.string().nullable(),
  archived: z.boolean().optional(),
  updated: z.string()
})
const handoffDetailWire = z.object({
  thread: handoffThread,
  task_proposal: handoffTaskProposal.nullable().optional(),
  files: z.array(handoffFile),
  reviews: z.array(handoffReview),
  entries: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      body: z.string(),
      created: z.string(),
      // Why: the hub returns each entry's stored references; the disposition is read back from them.
      references: z.array(z.unknown()).nullable().optional()
    })
  )
})
export const handoffDetail = handoffDetailWire.transform(withReviewWords)
export const handoffQueue = z.object({
  assignee: z.string(),
  /** `sent` when this page lists the reader's own requests; absent on received views. */
  view: z.string().optional(),
  /** Opaque keyset cursor for the next page; absent on servers without pagination. */
  next_cursor: z.string().nullable().optional(),
  threads: z.array(
    handoffThread.extend({
      files: z.array(handoffFile).default([]),
      reviews: z.array(handoffReview).default([]),
      // Why: the hub counts entries this person has not read; stripping it hid returned replies.
      unread_entries: z.number().int().nonnegative().optional()
    })
  )
})
const forwarded = {
  recipient: z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/),
  communicationType: communicationType.optional(),
  note,
  fileVersions: z.array(handoffFilePin).max(32),
  dueAt: z.string().datetime({ offset: true }).optional(),
  operationId
}
const requested = {
  ...forwarded,
  /** What the recipient is asked for; omitted, the hub keeps the thread's action NULL and the work says it. */
  action: handoffAction.optional(),
  // Why: the one input for ownership vs feedback; the client alone spells it as hub references.
  disposition: handoffDisposition.optional(),
  /** Which of the files is the generated summary / transcript, so the reader can set them apart. */
  summaryFile: z.string().min(1).max(255).optional(),
  transcriptFile: z.string().min(1).max(255).optional(),
  /** An omnios page the recipient is asked to decide on; rides as a reference, like the disposition. */
  artifactReview: handoffArtifactReview.optional()
}
export const handoffSend = z
  .object({ taskId, title: z.string().trim().min(1).max(160), ...requested })
  .strict()
// Why: the hub's ForwardBody forbids extras and has no references, and the relay requires an
// action, so a forward carries neither a disposition nor an absent ask.
export const handoffForward = z
  .object({ threadId: handoffId, ...forwarded, action: handoffAction })
  .strict()
export const handoffDecide = z
  .object({
    threadId: handoffId,
    decision: z.enum(['approve', 'request_changes']),
    versionIds: z.array(handoffVersionId).max(32),
    note,
    operationId
  })
  .strict()
export const exactHandoffFile = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/]/.test(value) && !value.includes(String.fromCharCode(0))),
    contentBase64: z.string().max(Math.ceil(HANDOFF_FILE_MAX_BYTES / 3) * 4),
    sha256: handoffDigest,
    size: z.number().int().nonnegative().max(HANDOFF_FILE_MAX_BYTES)
  })
  .strict()
export const exactHandoffThreadFile = exactHandoffFile.extend({
  contentBase64: z.string().max(Math.ceil(HANDOFF_THREAD_FILE_MAX_BYTES / 3) * 4),
  size: z.number().int().nonnegative().max(HANDOFF_THREAD_FILE_MAX_BYTES)
})
const CARDLESS_ATTACHMENTS_MAX = 32
/**
 * A handoff that is the exchange itself, not a task (hub `POST /api/handoffs`, migration 334):
 * no card, so no workspace paths to pin; the files travel with the request as exact bytes.
 */
export const handoffSendCardless = z
  .object({
    title: z.string().trim().min(1).max(160),
    recipient: requested.recipient,
    action: requested.action,
    communicationType: requested.communicationType,
    disposition: requested.disposition,
    summaryFile: requested.summaryFile,
    transcriptFile: requested.transcriptFile,
    artifactReview: requested.artifactReview,
    note,
    dueAt: requested.dueAt,
    operationId,
    attachments: z.array(exactHandoffFile).max(CARDLESS_ATTACHMENTS_MAX).default([])
  })
  .strict()
/** A new file on an open thread, by either participant (hub `POST /api/handoffs/{id}/files/upload`). */
export const handoffThreadUpload = z
  .object({
    threadId: handoffId,
    file: exactHandoffThreadFile,
    note,
    operationId
  })
  .strict()
/** "Make this a task": bind a card-less thread to an existing card (hub `POST /api/handoffs/{id}/bind`). */
export const handoffBind = z.object({ threadId: handoffId, taskId }).strict()
/** Answer on a thread as its party: `reply` marks it replied, `done` resolves it (hub `entries`). */
export const handoffRespondKind = z.enum(['reply', 'done', 'status'])
export const handoffRespond = z
  .object({ threadId: handoffId, kind: handoffRespondKind, note, operationId })
  .strict()
export const handoffArchive = z
  .object({ threadId: handoffId, archived: z.boolean(), operationId })
  .strict()
export const handoffArchiveReceipt = z.object({
  thread_id: handoffId,
  employee_id: z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/),
  archived: z.boolean(),
  replayed: z.boolean().optional()
})
export const handoffReturn = z
  .object({
    threadId: handoffId,
    baseVersionId: handoffVersionId,
    file: exactHandoffFile,
    note,
    operationId
  })
  .strict()
export type HandoffThread = z.infer<typeof handoffThread>
export type HandoffDetail = z.infer<typeof handoffDetail>
export type HandoffFile = z.infer<typeof handoffFile>
export type HandoffSend = z.infer<typeof handoffSend>
export type HandoffSendCardless = z.infer<typeof handoffSendCardless>
export type HandoffThreadUpload = z.infer<typeof handoffThreadUpload>
export type HandoffBind = z.infer<typeof handoffBind>
export type HandoffForward = z.infer<typeof handoffForward>
export type HandoffDecide = z.infer<typeof handoffDecide>
export type HandoffReturn = z.infer<typeof handoffReturn>
export type HandoffRespond = z.infer<typeof handoffRespond>
export type HandoffArchive = z.infer<typeof handoffArchive>
export type HandoffArchiveReceipt = z.infer<typeof handoffArchiveReceipt>
export type ExactHandoffFile = z.infer<typeof exactHandoffFile>
export type HandoffQueue = z.infer<typeof handoffQueue>
/** An active human on the roster; role, title and department only when the hub sends them. */
export type HandoffRecipient = {
  id: string
  name: string
  role?: string
  title?: string
  department?: string
  photo_url?: string
  image_url?: string
}
export type HandoffReceipt = {
  thread_id?: string
  forwarded_thread_id?: string
  entry_id?: string
  replayed?: boolean
}
export type ConsoleHandoffApi = {
  archiveMessage: (
    args: PeerMessageArchiveRequest
  ) => Promise<ConsoleWorkflowResult<PeerMessageArchiveReceipt>>
  getAgentMessage: (
    args: ChatAgentMessageRequest
  ) => Promise<ConsoleWorkflowResult<ChatAgentMessageDetail>>
  readAgentMessage: (
    args: ChatAgentMessageRequest
  ) => Promise<ConsoleWorkflowResult<ChatAgentMessageDetail>>
  resolveAgentMessage: (
    args: ChatAgentMessageRequest
  ) => Promise<ConsoleWorkflowResult<{ message: { id: string; state: 'resolved' } }>>
  agentMessageFiles: (
    args: ChatAgentMessageRequest
  ) => Promise<ConsoleWorkflowResult<{ message_id: string; files: ChatAgentFile[] }>>
  downloadAgentFile: (
    args: ChatAgentMessageRequest & { file: ChatAgentFile }
  ) => Promise<ConsoleWorkflowResult<ExactHandoffFile>>
  agentRecipients: () => Promise<ConsoleWorkflowResult<{ agents: ChatAgentRecipient[] }>>
  sendAgent: (args: ChatAgentSend) => Promise<ConsoleWorkflowResult<ChatAgentReceipt>>
  list: (args?: {
    state?: 'open' | 'replied' | 'resolved'
    /** `archived` lists this person's archived sent and received threads; omitted means received. */
    view?: 'sent' | 'archived'
    cursor?: string
  }) => Promise<ConsoleWorkflowResult<HandoffQueue>>
  markRead: (args: { threadId: string }) => Promise<ConsoleWorkflowResult<HandoffDetail>>
  get: (args: { threadId: string }) => Promise<ConsoleWorkflowResult<HandoffDetail>>
  recipients: () => Promise<ConsoleWorkflowResult<{ employees: HandoffRecipient[] }>>
  taskFiles: (args: {
    taskId: string
  }) => Promise<
    ConsoleWorkflowResult<{ files: { rel: string; size: number; sha256: string | null }[] }>
  >
  send: (args: HandoffSend) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  /** A handoff with no card; refused unless card-less handoffs are on in Settings → Experimental. */
  sendCardless: (args: HandoffSendCardless) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  /** Add a file to an open thread (card-less or card-bound); gated like `sendCardless`. */
  uploadThreadFile: (args: HandoffThreadUpload) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  /** Bind a card-less thread to an existing card; gated like `sendCardless`. */
  bindThread: (args: HandoffBind) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  forward: (args: HandoffForward) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  review: (args: HandoffDecide) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  respond: (args: HandoffRespond) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  archive: (args: HandoffArchive) => Promise<ConsoleWorkflowResult<HandoffArchiveReceipt>>
  returnFile: (args: HandoffReturn) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  readFile: (args: {
    filePath: string
    connectionId?: string
  }) => Promise<ConsoleWorkflowResult<ExactHandoffFile>>
  /** Exact selected file bytes, or a portable archive preserving a selected folder's contents. */
  readAttachment: (args: {
    threadUpload?: boolean
    filePath: string
    connectionId?: string
  }) => Promise<ConsoleWorkflowResult<ExactHandoffFile>>
  uploadFile: (args: {
    taskId: string
    file: ExactHandoffFile
    purpose?: 'task'
    expectedPrincipal?: string
  }) => Promise<ConsoleWorkflowResult<{ path: string; sha256: string }>>
  downloadFile: (args: {
    threadId: string
    file: HandoffFile
  }) => Promise<ConsoleWorkflowResult<ExactHandoffFile>>
  /** Decide how each file of a handoff travels and carry it out, before anything is sent. */
  prepareRoutes: (
    args: HandoffRoutePreparationRequest
  ) => Promise<ConsoleWorkflowResult<HandoffRoutePreparation>>
  /** Put a received handoff on this computer: check out its branch, write its files back. */
  materialize: (args: {
    threadId: string
    workspacePath: string
    filesOnly?: boolean
  }) => Promise<ConsoleWorkflowResult<HandoffReceiveSummary>>
}

/** What `materialize` reports back: the branch, and every file with what happened to it. */
export type HandoffReceiveSummary = {
  manifest: unknown
  git: { branch: string; sha: string } | { refused: string } | null
  files: {
    root: string
    complete: boolean
    files: {
      rel: string
      name: string
      sha256: string
      size: number
      outcome: 'written' | 'unchanged' | 'refused'
      path?: string
      reason?: string
    }[]
  }
}
