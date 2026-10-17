import { z } from 'zod'
import { PEER_MESSAGE_ID, peerMessageState } from './peer-message-contract'

const id = z.string().regex(PEER_MESSAGE_ID)
const time = z.number().finite().nonnegative().max(8_640_000_000_000)
const cursor = id.nullable()
const link = z
  .string()
  .url()
  .regex(/^https?:\/\//)
export const peerRoom = z.object({
  id,
  name: z.string().min(1).max(160),
  project_id: id,
  task_id: id,
  state: z.enum(['open', 'closed']),
  active_members: z.number().int().min(0).max(6),
  created_at: time
})
export type PeerRoom = z.infer<typeof peerRoom>
export const peerRoomPage = z.object({ rooms: z.array(peerRoom).max(20), next_cursor: cursor })
export const peerRoomDetail = z.object({
  room_id: id,
  room: peerRoom,
  members: z
    .array(
      z.object({
        id,
        room_id: id,
        employee_id: id,
        employee_name: z.string(),
        label: z.string(),
        presence: z.string()
      })
    )
    .max(20),
  members_truncated: z.boolean(),
  membership: z.null()
})
export type PeerRoomDetail = z.infer<typeof peerRoomDetail>
export const peerRoomPost = z.object({
  id,
  room_id: id,
  sender_employee_id: id,
  summary: z.string().max(4000),
  created_at: time,
  references: z.array(link).max(4),
  deliveries: z
    .array(
      z.object({
        id,
        recipient_employee_id: id,
        state: peerMessageState,
        reply: z.object({ id, summary: z.string().max(4000), created_at: time }).nullable()
      })
    )
    .max(6)
})
export type PeerRoomPost = z.infer<typeof peerRoomPost>
export const peerRoomMessages = z.object({
  posts: z.array(peerRoomPost).max(20),
  next_cursor: cursor
})
