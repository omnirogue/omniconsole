import type { IpcRenderer } from 'electron'
import type { ConsoleAdvertisingApi } from '../../shared/console-advertising-contract'

export function createConsoleAdvertisingApi(
  ipc: Pick<IpcRenderer, 'invoke'>
): ConsoleAdvertisingApi {
  return {
    salesAds: (args) => ipc.invoke('consoleAdvertising:salesAds', args),
    dailySales: (args) => ipc.invoke('consoleAdvertising:dailySales', args),
    webinar: (args) => ipc.invoke('consoleAdvertising:webinar', args),
    adOps: () => ipc.invoke('consoleAdvertising:adOps'),
    decision: (args) => ipc.invoke('consoleAdvertising:decision', args)
  }
}
