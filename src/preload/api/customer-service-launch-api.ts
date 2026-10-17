import type { IpcRenderer } from 'electron'
import type { CustomerServiceLaunchApi } from '../../shared/customer-service-launch'

export function createCustomerServiceLaunchApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): CustomerServiceLaunchApi {
  return {
    onOpen(listener) {
      const handler = (_event: unknown, id: string) => listener(id)
      ipc.on('customerService:open', handler)
      return () => ipc.removeListener('customerService:open', handler)
    },
    consumePending: () => ipc.invoke('customerService:consumePending'),
    preview: (id) => ipc.invoke('customerService:preview', id),
    begin: (args) => ipc.invoke('customerService:begin', args),
    receipt: (args) => ipc.invoke('customerService:receipt', args)
  }
}
