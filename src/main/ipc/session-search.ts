import { app, ipcMain } from 'electron'
import { SessionSearchQueryParams } from '../runtime/rpc/methods/session-search'
import { searchSessionsOnHosts } from '../session-search/session-search-hosts'
import type { SessionSearchResult } from '../../shared/session-search-types'

export function registerSessionSearchHandlers(): void {
  ipcMain.handle(
    'sessionSearch:query',
    async (_event, args: unknown): Promise<SessionSearchResult> => {
      const params = SessionSearchQueryParams.safeParse(args)
      if (!params.success) {
        return { query: '', hits: [], hosts: [], tookMs: 0 }
      }
      return searchSessionsOnHosts(app.getPath('userData'), params.data)
    }
  )
}
