import type { IpcRenderer } from 'electron'
import type { ConsoleQuickBooksApi } from '../../shared/console-quickbooks-contract'

export function createConsoleQuickBooksApi(ipc: Pick<IpcRenderer, 'invoke'>): ConsoleQuickBooksApi {
  return { status: () => ipc.invoke('consoleQuickBooks:status') }
}
