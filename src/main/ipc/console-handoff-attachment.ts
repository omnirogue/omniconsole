import { z } from 'zod'
import { captureHandoffAttachment } from '../backoffice/handoff-attachment-capture'
import {
  createHandoffAttachmentIo,
  HandoffAttachmentError
} from '../backoffice/handoff-attachment-source'
import { failure } from '../backoffice/console-workflow-refusal'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'

const attachmentRequest = z
  .object({
    threadUpload: z.boolean().optional(),
    filePath: z.string().min(1).max(4096),
    connectionId: z.string().min(1).max(512).optional()
  })
  .strict()

export async function readConsoleHandoffAttachment(args: unknown, store: Store) {
  const parsed = attachmentRequest.safeParse(args)
  if (!parsed.success) {
    return failure('invalid_request', 'Select a file or folder on its owning computer.')
  }
  try {
    const { filePath, connectionId } = parsed.data
    const path = connectionId
      ? filePath
      : await resolveAuthorizedPath(filePath, store, { preserveSymlink: true })
    return {
      ok: true as const,
      data: await captureHandoffAttachment(
        path,
        createHandoffAttachmentIo(connectionId),
        parsed.data.threadUpload
      )
    }
  } catch (error) {
    return failure(
      'file_unavailable',
      error instanceof HandoffAttachmentError
        ? error.message
        : 'The attachment could not be verified on its computer. Check the connection and file changes; older SSH hosts need an update.'
    )
  }
}
