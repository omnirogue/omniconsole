import { z } from 'zod'
import { communicationType } from './communication-type'

/** Canonical peer history shared by people and their agents. Replies retain the original ID. */
export const PEER_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/
const peerId = z.string().regex(PEER_MESSAGE_ID)
const peerTime = z.number().finite().nonnegative()

export const peerMessageState = z.enum(['queued', 'delivered', 'replied', 'resolved', 'expired'])
export type PeerMessageState = z.infer<typeof peerMessageState>

export const peerMessageThread = z.object({
  id: peerId,
  project_id: peerId,
  task_id: z.string().nullable().optional(),
  sender_session_id: z.string(),
  recipient_session_id: z.string(),
  sender_employee_id: z.string(),
  recipient_employee_id: z.string(),
  purpose: z.string(),
  communication_type: communicationType.nullable().optional(),
  attachment_count: z.number().int().nonnegative().optional(),
  summary: z.string(),
  state: peerMessageState,
  archived: z.boolean().optional(),
  archived_at: peerTime.nullable().optional(),
  /** Epoch seconds, the console's own clock. */
  created_at: peerTime,
  delivered_at: peerTime.nullable(),
  replied_at: peerTime.nullable(),
  resolved_at: peerTime.nullable(),
  expires_at: peerTime.nullable(),
  reply: z.object({ id: peerId, summary: z.string(), created_at: peerTime }).nullable()
})
export type PeerMessageThread = z.infer<typeof peerMessageThread>

export const peerMessageArchiveRequest = z
  .object({
    messageId: z.string().regex(/^pm_[a-f0-9]{24}$/),
    archived: z.boolean(),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/)
  })
  .strict()
export const peerMessageArchiveReceipt = z.object({
  message_id: z.string().regex(/^pm_[a-f0-9]{24}$/),
  employee_id: z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/),
  archived: z.boolean(),
  replayed: z.boolean().optional()
})
export type PeerMessageArchiveRequest = z.infer<typeof peerMessageArchiveRequest>
export type PeerMessageArchiveReceipt = z.infer<typeof peerMessageArchiveReceipt>

export const peerMessageProjectList = z.object({
  projects: z.array(z.object({ id: peerId, name: z.string() }))
})
export const peerMessageThreadPage = z.object({
  threads: z.array(peerMessageThread),
  next_cursor: z.string().nullable(),
  employee_id: z.string().optional(),
  view: z.enum(['active', 'archived', 'all']).optional()
})
export type PeerMessageThreadPage = z.infer<typeof peerMessageThreadPage>

/** A thread nobody has answered yet: it still waits on its recipient. */
export function isPeerMessageOpen(thread: Pick<PeerMessageThread, 'state'>): boolean {
  return thread.state === 'queued' || thread.state === 'delivered'
}

/** The moment the thread last moved, as ISO text (the row sorts by it). */
export function peerMessageUpdatedAt(thread: PeerMessageThread): string {
  const latest = Math.max(
    thread.created_at,
    thread.delivered_at ?? 0,
    thread.replied_at ?? 0,
    thread.resolved_at ?? 0,
    thread.reply?.created_at ?? 0
  )
  return new Date(latest * 1000).toISOString()
}
