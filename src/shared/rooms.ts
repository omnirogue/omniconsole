import type { z } from 'zod'
import type * as schemas from './room-schemas'

export type Room = z.infer<typeof schemas.room>
export type RoomAgent = z.infer<typeof schemas.roomAgent>
export type RoomDetail = z.infer<typeof schemas.roomDetail>
export type RoomEvent = z.infer<typeof schemas.roomEvent>
export type RoomSend = z.infer<typeof schemas.roomSend>
export type RoomPending = z.infer<typeof schemas.roomPending>
export const ROOM_ERROR_CODES = [
  'device_unauthorized',
  'forbidden',
  'idempotency_conflict',
  'room_full',
  'host_membership',
  'conflict',
  'invalid_request',
  'invalid_response',
  'response_too_large',
  'timeout',
  'network_error',
  'not_found',
  'rate_limited',
  'rooms_unavailable',
  'not_ready',
  'config_missing',
  'console_unavailable',
  'secure_storage_unavailable',
  'storage_error',
  'invalid_callback',
  'link_expired',
  'connection_changed'
] as const
export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number]
export type RoomResult<T> = { ok: true; data: T } | { ok: false; error: { code: RoomErrorCode } }
export type RoomAccountStatus = {
  state: 'unlinked' | 'linking' | 'linked'
  expiresAt?: number
  error?: RoomErrorCode
}
export type RoomOrigins = { apiOrigin: string; frontendOrigin: string }
export type RoomSnapshot = {
  events: RoomEvent[]
  sequence: string
  gaps: { expected: string; received: string }[]
  error?: RoomErrorCode
  retryMs: number
}
export type RoomsApi = {
  status(): Promise<RoomResult<RoomAccountStatus>>
  link(): Promise<RoomResult<RoomAccountStatus>>
  unlink(): Promise<RoomResult<RoomAccountStatus>>
  configure(origins: RoomOrigins): Promise<RoomResult<null>>
  listRooms(after?: string): Promise<RoomResult<z.infer<typeof schemas.roomList>>>
  getRoom(roomId: string): Promise<RoomResult<RoomDetail>>
  events(roomId: string, after: string): Promise<RoomResult<z.infer<typeof schemas.roomEvents>>>
  send(roomId: string, body: RoomSend): Promise<RoomResult<z.infer<typeof schemas.roomSendReceipt>>>
  pendingSummary(after?: string): Promise<RoomResult<RoomPending>>
  ack(roomId: string, sequence: string): Promise<RoomResult<z.infer<typeof schemas.roomAckReceipt>>>
  setWatchedRoom(roomId: string | null): Promise<RoomResult<RoomSnapshot | null>>
  onSnapshot(callback: (payload: { roomId: string; snapshot: RoomSnapshot }) => void): () => void
}
