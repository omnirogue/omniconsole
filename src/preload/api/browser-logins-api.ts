import type { IpcRenderer } from 'electron'
import type { BrowserLoginsApi } from '../../shared/browser-logins-contract'

export function createBrowserLoginsApi(ipc: Pick<IpcRenderer, 'invoke'>): BrowserLoginsApi {
  return {
    list: () => ipc.invoke('consoleBrowserLogins:list'),
    status: (args) => ipc.invoke('consoleBrowserLogins:status', args),
    open: (args) => ipc.invoke('consoleBrowserLogins:open', args),
    save: (args) => ipc.invoke('consoleBrowserLogins:save', args),
    verify: (args) => ipc.invoke('consoleBrowserLogins:verify', args),
    add: (args) => ipc.invoke('consoleBrowserLogins:add', args),
    verifyAll: () => ipc.invoke('consoleBrowserLogins:verifyAll')
  }
}
