import type { IpcRenderer } from 'electron'
import type { AssistedBriefApi } from '../../shared/assisted-brief-contract'

export function createAssistedBriefApi(ipc: Pick<IpcRenderer, 'invoke'>): AssistedBriefApi {
  return {
    generate: (args) => ipc.invoke('assistedBrief:generate', args),
    cancel: (args) => ipc.invoke('assistedBrief:cancel', args)
  }
}
