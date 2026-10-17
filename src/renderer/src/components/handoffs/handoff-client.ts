import type {
  ConsoleHandoffApi,
  ExactHandoffFile
} from '../../../../shared/console-handoff-contract'
import { HANDOFF_FILE_MAX_BYTES } from '../../../../shared/console-handoff-contract'
import { workflowData } from '@/lib/console-workflow-client'

export function handoffApi(): ConsoleHandoffApi {
  if (!window.api.consoleHandoffs) {
    throw new Error('Handoffs require an updated desktop. Your tasks remain available.')
  }
  return window.api.consoleHandoffs
}

export async function capturePickedHandoffFile(file: File): Promise<ExactHandoffFile> {
  if (file.size > HANDOFF_FILE_MAX_BYTES) {
    throw new Error('Choose a file up to 10 MB.')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return { name: file.name, size: bytes.length, sha256, contentBase64: btoa(binary) }
}

export async function downloadHandoffVersion(
  threadId: string,
  file: Parameters<ConsoleHandoffApi['downloadFile']>[0]['file']
) {
  const exact = workflowData(await handoffApi().downloadFile({ threadId, file }))
  downloadExactHandoffFile(exact)
}

export function downloadExactHandoffFile(exact: ExactHandoffFile) {
  const bytes = Uint8Array.from(atob(exact.contentBase64), (char) => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = exact.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The text of one handoff file version, decoded as UTF-8 (for inline previews). */
export async function readHandoffVersionText(
  threadId: string,
  file: Parameters<ConsoleHandoffApi['downloadFile']>[0]['file']
): Promise<string> {
  const exact = workflowData(await handoffApi().downloadFile({ threadId, file }))
  const bytes = Uint8Array.from(atob(exact.contentBase64), (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}
