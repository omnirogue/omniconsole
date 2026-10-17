import { PEER_MESSAGE_ID } from '../../../shared/peer-message-contract'
import { peerRoomDetail, peerRoomMessages, peerRoomPage } from '../../../shared/peer-room-contract'
import { readPeerFeed } from './peer-messages'

function identifier(value: string): string {
  if (!PEER_MESSAGE_ID.test(value)) {
    throw new Error('Invalid discussion identifier.')
  }
  return value
}

function pageQuery(cursor?: string): URLSearchParams {
  const query = new URLSearchParams({ limit: '20' })
  if (cursor) {
    query.set('cursor', identifier(cursor))
  }
  return query
}

export async function readPeerRooms(projectId: string, cursor?: string) {
  const query = pageQuery(cursor)
  query.set('project_id', identifier(projectId))
  const page = await readPeerFeed(`/rooms?${query}`, peerRoomPage)
  if (page.rooms.some((room) => room.project_id !== projectId)) {
    throw new Error('Discussion project mismatch.')
  }
  return page
}

export async function readPeerRoom(projectId: string, roomId: string) {
  identifier(projectId)
  const detail = await readPeerFeed(`/rooms/${identifier(roomId)}`, peerRoomDetail)
  if (
    detail.room_id !== roomId ||
    detail.room.id !== roomId ||
    detail.room.project_id !== projectId ||
    detail.members.some((member) => member.room_id !== roomId)
  ) {
    throw new Error('Discussion scope mismatch.')
  }
  return detail
}

export async function readPeerRoomMessages(roomId: string, cursor?: string) {
  const page = await readPeerFeed(
    `/rooms/${identifier(roomId)}/messages?${pageQuery(cursor)}`,
    peerRoomMessages
  )
  if (page.posts.some((post) => post.room_id !== roomId)) {
    throw new Error('Discussion message scope mismatch.')
  }
  return page
}
