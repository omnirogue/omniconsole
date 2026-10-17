// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { readPeerRoom, readPeerRoomMessages, readPeerRooms } from './peer-rooms'

const feed = vi.fn()
const room = {
  id: 'room_1',
  project_id: 'project_1',
  task_id: 'task_1',
  name: 'Review',
  state: 'open',
  active_members: 1,
  created_at: 1
}
const detail = { room_id: 'room_1', room, members: [], members_truncated: false, membership: null }
const post = {
  id: 'post_1',
  room_id: 'room_1',
  sender_employee_id: 'emp_one',
  summary: 'Version ready',
  created_at: 2,
  references: ['https://example.com/file'],
  deliveries: [
    {
      id: 'delivery_1',
      recipient_employee_id: 'emp_two',
      state: 'replied',
      reply: { id: 'reply_1', summary: 'Reviewed', created_at: 3 }
    }
  ]
}
beforeEach(() => {
  feed.mockReset()
  Object.assign(window, { api: { backoffice: { feed } } })
})

it('reads existing room IDs, task links, delivery receipts and replies with explicit pagination', async () => {
  feed.mockResolvedValueOnce({ ok: true, body: { rooms: [room], next_cursor: 'room_2' } })
  expect(await readPeerRooms('project_1')).toEqual({ rooms: [room], next_cursor: 'room_2' })
  feed.mockResolvedValueOnce({ ok: true, body: detail })
  expect((await readPeerRoom('project_1', 'room_1')).room.task_id).toBe('task_1')
  feed.mockResolvedValueOnce({ ok: true, body: { posts: [post], next_cursor: null } })
  expect(
    (await readPeerRoomMessages('room_1', 'post_2')).posts[0]?.deliveries[0]?.reply?.summary
  ).toBe('Reviewed')
  expect(feed).toHaveBeenLastCalledWith({
    path: '/api/estate/peers/rooms/room_1/messages?limit=20&cursor=post_2'
  })
})

it('refuses a room from another project or a member from another room', async () => {
  feed.mockResolvedValueOnce({
    ok: true,
    body: { rooms: [{ ...room, project_id: 'other' }], next_cursor: null }
  })
  await expect(readPeerRooms('project_1')).rejects.toThrow('project mismatch')
  feed.mockResolvedValueOnce({
    ok: true,
    body: {
      ...detail,
      members: [
        {
          id: 'm_1',
          room_id: 'other',
          employee_id: 'emp_one',
          employee_name: 'One',
          label: 'AI',
          presence: 'offline'
        }
      ]
    }
  })
  await expect(readPeerRoom('project_1', 'room_1')).rejects.toThrow('scope mismatch')
})

it('refuses mixed-room messages and unsafe reference schemes', async () => {
  feed.mockResolvedValueOnce({
    ok: true,
    body: { posts: [{ ...post, room_id: 'other' }], next_cursor: null }
  })
  await expect(readPeerRoomMessages('room_1')).rejects.toThrow('scope mismatch')
  feed.mockResolvedValueOnce({
    ok: true,
    body: { posts: [{ ...post, references: ['javascript:alert(1)'] }], next_cursor: null }
  })
  await expect(readPeerRoomMessages('room_1')).rejects.toThrow('could not be verified')
})

it('reports authorization failures and refuses invalid identifiers before transport', async () => {
  feed.mockResolvedValue({ ok: false, message: 'HTTP 403: project access revoked' })
  await expect(readPeerRooms('project_1')).rejects.toThrow('access revoked')
  feed.mockClear()
  await expect(readPeerRoomMessages('../admin')).rejects.toThrow('Invalid discussion')
  expect(feed).not.toHaveBeenCalled()
})
