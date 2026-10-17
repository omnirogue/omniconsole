import type { IpcRenderer } from 'electron'
import type { EnsureCompanyFolderResult } from '../../shared/company-folders'

// Why: api-types.ts sits at the max-lines limit; the launcher API rides on this import.
export type { LocalOllamaApi, LocalOllamaPreloadApi } from './local-ollama-api'

/** Company folders on this host: where home is, and creating one inside the work root. */
export type CompanyWorkspacesApi = {
  home: () => Promise<string>
  ensureFolder: (args: { path: string }) => Promise<EnsureCompanyFolderResult>
}

export function createCompanyWorkspacesApi(ipc: Pick<IpcRenderer, 'invoke'>): CompanyWorkspacesApi {
  return {
    home: () => ipc.invoke('companyWorkspaces:home'),
    ensureFolder: (args) => ipc.invoke('companyWorkspaces:ensureFolder', args)
  }
}
