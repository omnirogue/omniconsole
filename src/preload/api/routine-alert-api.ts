import type { IpcRenderer } from 'electron'
import type { RoutineAlertApi } from '../../shared/routine-alert-contract'

export function createRoutineAlertApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): RoutineAlertApi {
  return {
    consumePendingOpenRun: () => ipc.invoke('routines:consumePendingOpenRun'),
    onOpenRun: (listener) => {
      const handle = (_event: unknown, target: Parameters<typeof listener>[0]) => listener(target)
      ipc.on('routines:openRun', handle)
      return () => {
        ipc.removeListener('routines:openRun', handle)
      }
    },
    deliverRun: (input) => ipc.invoke('alerts:deliverRun', input),
    slack: {
      status: () => ipc.invoke('alerts:slack:status'),
      listChannels: (refresh) => ipc.invoke('alerts:slack:listChannels', refresh),
      send: (payload) => ipc.invoke('alerts:slack:send', payload)
    }
  }
}
