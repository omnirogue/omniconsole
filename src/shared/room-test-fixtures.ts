import type { RoomDetail, RoomEvent } from './rooms'

export const ID = 'a0000000-0000-4000-8000-000000000001'
export const USER = 'b0000000-0000-4000-8000-000000000001'
export const TOKEN = `or_obp_${'x'.repeat(43)}`
export const detail: RoomDetail = {
  id: ID,
  tenantId: 'customer',
  name: 'Room',
  memberCount: 1,
  currentUserId: USER,
  code: 'abcdef123456',
  members: [{ userId: USER, name: 'Sal', role: 'host' }],
  agents: [
    {
      id: ID,
      ownerId: USER,
      name: 'Research',
      mode: 'mentions',
      available: true,
      respondTo: 'room-members',
      allowUserIds: [],
      delivery: 'queue',
      exposure: 'live'
    }
  ]
}
export const roomEvent = (sequence = '1', overrides: Partial<RoomEvent> = {}): RoomEvent => ({
  eventId: ID,
  sequence,
  senderId: USER,
  senderKind: 'human',
  senderName: 'Sal',
  content: 'Hello',
  createdAt: '2026-09-13T12:00:00.000Z',
  eventKind: 'message',
  turnId: null,
  metadata: null,
  mentionedUserIds: [],
  ...overrides
})
export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
