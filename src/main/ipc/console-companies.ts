import { ipcMain } from 'electron'
import { consoleCompaniesClient } from '../backoffice/console-companies-client'

/** One handler per read, plus the bank refresh; the client owns validation and the credential. */
export function registerConsoleCompanyHandlers(): void {
  for (const name of [
    'rollup',
    'scorecard',
    'me',
    'orgChart',
    'missions',
    'today',
    'org',
    'folders',
    'company',
    'health',
    'accounting',
    'syncAccounting',
    'transactionsCsv'
  ] as const) {
    ipcMain.handle(`consoleCompanies:${name}`, (_event, args) => {
      const operation = consoleCompaniesClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
}
