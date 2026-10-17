import { ipcMain } from 'electron'
import { z } from 'zod'
import { basename } from 'node:path'
import type { Store } from '../persistence'
import { consoleHandoffClient } from '../backoffice/console-handoff-client'
import { uploadHandoffFile, downloadHandoffFile } from '../backoffice/console-handoff-files'
import { prepareHandoffRoutes } from '../backoffice/handoff-route-prepare'
import { materializeHandoff } from '../backoffice/handoff-receive'
import { failure } from '../backoffice/console-workflow-transport'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { resolveAuthorizedPath } from './filesystem-auth'
import { isMethodNotFoundError } from '../ssh/ssh-file-stream-contract'
import { capturedHandoffFile, readExactHandoffFile } from '../../shared/exact-handoff-file-read'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { readConsoleHandoffAttachment } from './console-handoff-attachment'
import {
  CARDLESS_HANDOFF_VERBS,
  cardlessHandoffsRefusal
} from '../backoffice/console-handoff-cardless-gate'

const fileRequest = z
  .object({
    filePath: z.string().min(1).max(4096),
    connectionId: z.string().min(1).max(512).optional()
  })
  .strict()

export function registerConsoleHandoffHandlers(store: Store): void {
  ipcMain.handle('consoleHandoffs:readAttachment', (_event, args) =>
    readConsoleHandoffAttachment(args, store)
  )
  ipcMain.handle('consoleHandoffs:uploadFile', (_event, args) => uploadHandoffFile(args))
  // How each file of a handoff travels, decided and carried out before anything is sent.
  ipcMain.handle('consoleHandoffs:prepareRoutes', (_event, args) => prepareHandoffRoutes(args))
  // The receive half: check the branch out, then put the rest of the files back on disk.
  ipcMain.handle('consoleHandoffs:materialize', (_event, args) => materializeHandoff(args, store))
  ipcMain.handle('consoleHandoffs:downloadFile', (_event, args) => downloadHandoffFile(args))
  for (const name of [
    'archiveMessage',
    'getAgentMessage',
    'readAgentMessage',
    'resolveAgentMessage',
    'agentMessageFiles',
    'downloadAgentFile',
    'agentRecipients',
    'sendAgent',
    'list',
    'get',
    'markRead',
    'recipients',
    'taskFiles',
    'send',
    'forward',
    'review',
    'respond',
    'archive',
    'returnFile'
  ] as const) {
    ipcMain.handle(`consoleHandoffs:${name}`, (_event, args) => {
      const operation = consoleHandoffClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
  for (const name of CARDLESS_HANDOFF_VERBS) {
    ipcMain.handle(`consoleHandoffs:${name}`, (_event, args) => {
      // Why: the setting is read per call, so flipping it needs no restart and no stale gate.
      const refused = cardlessHandoffsRefusal(store.getSettings())
      if (refused) {
        return refused
      }
      const operation = consoleHandoffClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
  ipcMain.handle('consoleHandoffs:readFile', async (_event, args) => {
    const parsed = fileRequest.safeParse(args)
    if (!parsed.success) {
      return failure('invalid_request', 'Select a file on its owning computer.')
    }
    try {
      const { filePath, connectionId } = parsed.data
      if (connectionId) {
        const provider = requireSshFilesystemProvider(connectionId)
        if (!provider.readExactFile) {
          return failure('capability_unavailable', 'Update the SSH host to attach its files.')
        }
        const result = await provider.readExactFile(filePath, HANDOFF_FILE_MAX_BYTES)
        if (!result.isBinary) {
          throw new Error('The host did not return original file bytes.')
        }
        const bytes = Buffer.from(result.content, 'base64')
        if (bytes.toString('base64') !== result.content) {
          throw new Error('Invalid file encoding.')
        }
        return {
          ok: true,
          data: capturedHandoffFile(basename(filePath.replaceAll('\\', '/')), bytes)
        }
      }
      const authorized = await resolveAuthorizedPath(filePath, store)
      return { ok: true, data: await readExactHandoffFile(authorized) }
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        return failure(
          'capability_unavailable',
          'Update the SSH host to attach its original files.'
        )
      }
      return failure(
        'file_unavailable',
        'The original file could not be read on its computer. Check the connection, file changes, and 10 MB limit; older SSH hosts need an update.'
      )
    }
  })
}
