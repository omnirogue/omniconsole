import { capturePickedHandoffFile } from '@/components/handoffs/handoff-client'
import {
  HANDOFF_FILE_MAX_BYTES,
  type ExactHandoffFile
} from '../../../shared/console-handoff-contract'

export const CONVERSATION_FLEET_INPUT_MAX_FILES = 32
export const CONVERSATION_FLEET_INPUT_MAX_BYTES = 32 * 1024 * 1024

async function digestConversationBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function conversationFleetTextDigest(text: string): Promise<string> {
  return digestConversationBytes(new TextEncoder().encode(text))
}

export async function conversationFleetTextFiles(
  text: string,
  label: string,
  extension: 'md' | 'jsonl' | 'json' | 'txt'
): Promise<{ digest: string; files: ExactHandoffFile[] }> {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > CONVERSATION_FLEET_INPUT_MAX_BYTES) {
    throw new Error(
      'The complete conversation exceeds the fleet’s 32 MB input limit. No workflow was dispatched.'
    )
  }
  const digest = await digestConversationBytes(bytes)
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + HANDOFF_FILE_MAX_BYTES, bytes.length)
    // Keep every part readable while concatenating to the exact original UTF-8 bytes.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1
    }
    parts.push(bytes.slice(offset, end))
    offset = end
  }
  if (parts.length === 0) {
    parts.push(new Uint8Array())
  }
  const files: ExactHandoffFile[] = []
  for (const [index, part] of parts.entries()) {
    const suffix =
      parts.length > 1 ? `.part-${String(index + 1).padStart(2, '0')}-of-${parts.length}` : ''
    files.push(
      await capturePickedHandoffFile(
        new File([part], `${label}-${digest.slice(0, 24)}${suffix}.${extension}`)
      )
    )
  }
  return { digest, files }
}
