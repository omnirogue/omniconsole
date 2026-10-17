import type { IpcRenderer } from 'electron'
import type { RoomsApi } from '../../shared/rooms'

export function createRoomsApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): RoomsApi {
  return {
    status: () => ipc.invoke('rooms:status'),
    link: () => ipc.invoke('rooms:link'),
    unlink: () => ipc.invoke('rooms:unlink'),
    configure: (origins) => ipc.invoke('rooms:configure', origins),
    listRooms: (after) => ipc.invoke('rooms:listRooms', after),
    getRoom: (id) => ipc.invoke('rooms:getRoom', id),
    events: (id, after) => ipc.invoke('rooms:events', id, after),
    send: (id, body) => ipc.invoke('rooms:send', id, body),
    pendingSummary: (after) => ipc.invoke('rooms:pendingSummary', after),
    ack: (id, sequence) => ipc.invoke('rooms:ack', id, sequence),
    setWatchedRoom: (id) => ipc.invoke('rooms:watch', id),
    onSnapshot: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<typeof callback>[0]
      ) => callback(payload)
      ipc.on('rooms:snapshot', listener)
      return () => {
        ipc.removeListener('rooms:snapshot', listener)
      }
    }
  }
}
