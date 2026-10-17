import { opendir } from 'node:fs/promises'
import { createFleetSourceIo, type FleetSourceIo } from '../runtime/conversation-fleet-source-io'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

export const HANDOFF_FOLDER_MAX_ENTRIES = 1024

export class HandoffAttachmentError extends Error {}

export type HandoffAttachmentIo = FleetSourceIo & {
  readNames(path: string): Promise<string[]>
}

function assertEntryCount(count: number): void {
  if (count > HANDOFF_FOLDER_MAX_ENTRIES) {
    throw new HandoffAttachmentError('Choose a folder with at most 1,024 files and folders.')
  }
}

export function createHandoffAttachmentIo(connectionId?: string): HandoffAttachmentIo {
  const io = createFleetSourceIo(connectionId)
  if (connectionId !== undefined) {
    const provider = requireSshFilesystemProvider(connectionId)
    return {
      ...io,
      readNames: async (path) => {
        if (provider !== requireSshFilesystemProvider(connectionId)) {
          throw new HandoffAttachmentError('The source computer changed. Attach the folder again.')
        }
        const entries = await provider.readDir(path)
        if (provider !== requireSshFilesystemProvider(connectionId)) {
          throw new HandoffAttachmentError('The source computer changed. Attach the folder again.')
        }
        assertEntryCount(entries.length)
        return entries.map((entry) => entry.name)
      }
    }
  }
  return {
    ...io,
    readNames: async (path) => {
      const names: string[] = []
      for await (const entry of await opendir(path)) {
        names.push(entry.name)
        assertEntryCount(names.length)
      }
      return names
    }
  }
}
