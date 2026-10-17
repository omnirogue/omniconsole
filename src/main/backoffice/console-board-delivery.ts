import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { isBoardTaskId } from '../../shared/board-task-id'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  failure,
  requestConsoleWorkflow,
  requestConsoleWorkflowUpload,
  type ConsoleWorkflowUploadFile
} from './console-workflow-transport'

/** One artifact bigger than this is named in the message instead of being uploaded. */
const MAX_FILE_BYTES = 32 * 1024 * 1024

const uploadResponse = z.object({}).loose()
const deliverResponse = z.object({}).loose()

export type ConsoleBoardDeliveryRequest = {
  taskId: string
  /** Absolute paths of the produced artifacts. Any MIME type. */
  paths: string[]
  to: string[]
  message?: string
}

export type ConsoleBoardDeliveryReceipt = {
  /** sha256 of every file that was uploaded, keyed by the name the board stored. */
  files: { name: string; sha256: string; bytes: number }[]
  skipped: { path: string; reason: string }[]
  upload: unknown
  delivery: unknown
}

// Why: the board stores by name; the type is advisory. A short table keeps the
// common artifact kinds honest and everything else stays an opaque byte stream.
const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip'
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Hand produced files to a person or a card through the console board routes: upload
 * to the card's workspace, then deliver by name. Content-addressed — every uploaded
 * file's sha256 is computed here and stated in the instructions log, so the receipt
 * names exactly the bytes that were sent. Nothing goes through git.
 */
export async function deliverConsoleBoardFiles(
  request: ConsoleBoardDeliveryRequest
): Promise<ConsoleWorkflowResult<ConsoleBoardDeliveryReceipt>> {
  if (!isBoardTaskId(request.taskId)) {
    return failure('invalid_request', 'A delivery needs a board card id that looks like btk_….')
  }
  if (request.to.length === 0) {
    return failure('invalid_request', 'A delivery needs at least one recipient.')
  }
  const files: ConsoleWorkflowUploadFile[] = []
  const digests: ConsoleBoardDeliveryReceipt['files'] = []
  const skipped: ConsoleBoardDeliveryReceipt['skipped'] = []
  const seen = new Set<string>()
  for (const path of request.paths) {
    const name = basename(path)
    if (seen.has(name)) {
      skipped.push({ path, reason: 'another produced file already uses this name' })
      continue
    }
    let bytes: Buffer<ArrayBuffer>
    try {
      if (statSync(path).size > MAX_FILE_BYTES) {
        skipped.push({
          path,
          reason: 'larger than the board upload limit; use the task’s Google Drive folder'
        })
        continue
      }
      bytes = readFileSync(path)
    } catch {
      skipped.push({ path, reason: 'could not be read' })
      continue
    }
    seen.add(name)
    files.push({ name, contentType: contentTypeFor(path), bytes })
    digests.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength
    })
  }
  if (files.length === 0) {
    return failure('invalid_request', 'None of the produced files could be delivered.')
  }
  const instructions = [
    request.message?.trim() || 'Produced by a local OmniConsole run.',
    '',
    ...digests.map((file) => `${file.sha256}  ${file.name} (${file.bytes} bytes)`),
    ...skipped.map((entry) => `skipped: ${entry.path} — ${entry.reason}`)
  ].join('\n')
  const uploaded = await requestConsoleWorkflowUpload(
    `/api/gtd/hub/api/board/${request.taskId}/files/upload`,
    uploadResponse,
    { files, instructions }
  )
  if (!uploaded.ok) {
    return uploaded
  }
  const delivered = await requestConsoleWorkflow(
    `/api/gtd/hub/api/board/${request.taskId}/deliver`,
    'POST',
    deliverResponse,
    {
      files: digests.map((file) => `uploads/${file.name}`),
      to: request.to,
      message: instructions
    },
    60_000
  )
  if (!delivered.ok) {
    return delivered
  }
  return {
    ok: true,
    data: { files: digests, skipped, upload: uploaded.data, delivery: delivered.data }
  }
}
