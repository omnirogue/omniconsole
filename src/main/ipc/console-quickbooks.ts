import { ipcMain } from 'electron'
import { consoleQuickBooksClient } from '../backoffice/console-quickbooks-client'

/** One handler, one read. The books connection has no write on this surface. */
export function registerConsoleQuickBooksHandlers(): void {
  ipcMain.handle('consoleQuickBooks:status', () => consoleQuickBooksClient.status())
}
