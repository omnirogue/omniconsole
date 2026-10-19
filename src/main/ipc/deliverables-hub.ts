import { ipcMain } from 'electron'
import { resolvePlan, searchPlans } from '../deliverables-hub/plans-index'

export function registerDeliverablesHubHandlers(): void {
  ipcMain.handle('deliverablesHub:search', (_event, query: unknown, refresh: unknown) =>
    searchPlans(typeof query === 'string' ? query : '', refresh === true)
  )
  ipcMain.handle('deliverablesHub:resolve', (_event, path: unknown, modifiedAt: unknown) => {
    if (typeof path !== 'string' || typeof modifiedAt !== 'number') {
      throw new Error('Invalid deliverable')
    }
    return resolvePlan(path, modifiedAt)
  })
}
