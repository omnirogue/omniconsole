import type { IpcRenderer } from 'electron'
import type { ConsoleCompaniesApi } from '../../shared/console-companies-contract'

export function createConsoleCompaniesApi(ipc: Pick<IpcRenderer, 'invoke'>): ConsoleCompaniesApi {
  return {
    rollup: () => ipc.invoke('consoleCompanies:rollup'),
    scorecard: () => ipc.invoke('consoleCompanies:scorecard'),
    me: () => ipc.invoke('consoleCompanies:me'),
    orgChart: () => ipc.invoke('consoleCompanies:orgChart'),
    missions: () => ipc.invoke('consoleCompanies:missions'),
    today: () => ipc.invoke('consoleCompanies:today'),
    org: () => ipc.invoke('consoleCompanies:org'),
    folders: () => ipc.invoke('consoleCompanies:folders'),
    company: (args) => ipc.invoke('consoleCompanies:company', args),
    health: (args) => ipc.invoke('consoleCompanies:health', args),
    accounting: (args) => ipc.invoke('consoleCompanies:accounting', args),
    syncAccounting: (args) => ipc.invoke('consoleCompanies:syncAccounting', args),
    transactionsCsv: (args) => ipc.invoke('consoleCompanies:transactionsCsv', args)
  }
}
