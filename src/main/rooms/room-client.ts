// Native device credentials authorize the existing OmniRogue room service.
import { z } from 'zod'
import * as s from './room-schemas'
import { RoomError } from './room-error'
import { roomRequest } from './room-request'
import type { RoomSend } from '../../shared/rooms'

export type RoomAccess = { token: string; apiOrigin: string; check(): void }
export class RoomClient {
  constructor(
    private readonly access: () => RoomAccess | Promise<RoomAccess>,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    eventId?: string
  ): Promise<T> {
    const lease = await this.access()
    lease.check()
    const response = await roomRequest(
      this.fetcher,
      `${lease.apiOrigin}/api/omniconsole/rooms${path}`,
      {
        token: lease.token,
        body,
        idempotencyKey: eventId
      }
    )
    lease.check()
    const parsed = schema.safeParse(response)
    if (!parsed.success) {
      throw new RoomError('invalid_response')
    }
    return parsed.data
  }
  listRooms(after?: string) {
    return this.request(
      after === undefined ? '' : `?after=${encodeURIComponent(z.string().max(300).parse(after))}`,
      s.roomList
    )
  }
  getRoom(id: string) {
    return this.request(`/${s.roomId.parse(id)}`, s.roomDetail)
  }
  events(id: string, after: string) {
    const cursor = z.union([s.sequence, z.literal('latest')]).parse(after)
    return this.request(`/${s.roomId.parse(id)}/events?after=${cursor}`, s.roomEvents)
  }
  send(id: string, raw: RoomSend) {
    const body = s.roomSend.parse(raw)
    return this.request(`/${s.roomId.parse(id)}/messages`, s.roomSendReceipt, body, body.eventId)
  }
  pendingSummary(after?: string) {
    return this.request(
      `/pending_summary${after === undefined ? '' : `?after=${s.roomId.parse(after)}`}`,
      s.roomPending
    )
  }
  ack(id: string, sequence: string) {
    return this.request(
      `/${s.roomId.parse(id)}/ack`,
      s.roomAckReceipt,
      s.roomAck.parse({ sequence })
    )
  }
  // Tickets are credentials too: kept in main for a future native socket, never IPC.
  connectionTicket() {
    return this.request('/connection', s.roomConnection, {})
  }
}
