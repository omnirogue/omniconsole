import { ipcMain } from 'electron'
import type { HostResourceReading } from '../../shared/host-resource-model'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { Store } from '../persistence'
import { collectMemorySnapshot } from '../memory/collector'
import { MAX_HOST_RESOURCE_KEYS } from '../session-host-remote/host-resource-reader'
import { getHostResourceReader } from '../session-host-remote/host-resource-reader-runtime'

function hostKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 4096
        )
        .slice(0, MAX_HOST_RESOURCE_KEYS)
    : []
}

export function registerMemoryHandlers(store: Store): void {
  ipcMain.handle('memory:getSnapshot', (): Promise<MemorySnapshot> => collectMemorySnapshot(store))
  ipcMain.handle(
    'memory:getHostResources',
    (_event, keys: unknown): Promise<HostResourceReading[]> =>
      getHostResourceReader().read(hostKeys(keys))
  )
}
