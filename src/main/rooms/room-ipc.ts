import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { getRoomConfig, configureRoomOrigins } from './room-config'
import { ROOM_CALLBACK } from './room-credential-store'
import { RoomError, roomResult } from './room-error'
import { roomId, roomSend, sequence } from './room-schemas'
import { RoomService } from './room-service'
import type { RoomSnapshot } from '../../shared/rooms'

export function registerRoomIpc(
  ipc: Pick<IpcMain, 'handle'>,
  options: {
    trusted(event: IpcMainInvokeEvent): boolean
    openBrowser(url: string): Promise<void>
    publish(roomId: string, snapshot: RoomSnapshot): void
  }
) {
  let active: RoomService | undefined
  const service = async () => {
    const config = await getRoomConfig()
    if (!active || active.config.key !== config.key || !active.config.isCurrent()) {
      active?.dispose()
      active = new RoomService(config, options.openBrowser, options.publish)
    }
    return active
  }
  const handle = (name: string, run: (...args: unknown[]) => Promise<unknown>) => {
    ipc.handle(`rooms:${name}`, (event, ...args: unknown[]) =>
      roomResult(async () => {
        if (!options.trusted(event)) {
          throw new RoomError('forbidden')
        }
        return run(...args)
      })
    )
  }
  handle('status', async () => (await service()).credentials.status())
  handle('link', async () => {
    const current = await service()
    current.clearHistory()
    return current.credentials.link()
  })
  handle('unlink', async () => {
    const current = await service()
    current.clearHistory()
    return current.credentials.unlink()
  })
  handle('configure', async (origins) => {
    const result = await configureRoomOrigins(origins)
    active?.dispose()
    active = undefined
    return result
  })
  handle('listRooms', async (after) =>
    (await service()).client.listRooms(z.string().max(300).optional().parse(after))
  )
  handle('getRoom', async (id) => (await service()).client.getRoom(roomId.parse(id)))
  handle('events', async (id, after) =>
    (await service()).client.events(
      roomId.parse(id),
      z.union([sequence, z.literal('latest')]).parse(after)
    )
  )
  handle('send', async (id, body) =>
    (await service()).client.send(roomId.parse(id), roomSend.parse(body))
  )
  handle('pendingSummary', async (after) =>
    (await service()).client.pendingSummary(roomId.optional().parse(after))
  )
  handle('ack', async (id, cursor) =>
    (await service()).client.ack(roomId.parse(id), sequence.parse(cursor))
  )
  handle('watch', async (id) => {
    const parsed = roomId.nullable().parse(id)
    if (parsed === null) {
      return active?.watch(null) ?? null
    }
    return (await service()).watch(parsed)
  })
  return {
    acceptUrl(raw: string): boolean {
      if (!raw.startsWith(`${ROOM_CALLBACK}?`)) {
        return false
      }
      // Callback errors contain no URLs/codes/tokens and are never logged.
      const receiver = active
      if (receiver) {
        void roomResult(() => receiver.credentials.acceptCallback(raw)).then((result) => {
          if (!result.ok) {
            receiver.credentials.recordLinkError(result.error.code)
          }
        })
      }
      return true
    },
    dispose() {
      active?.dispose()
      active = undefined
    }
  }
}
