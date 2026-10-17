import { JsonRpcErrorCode, RelayErrorCode } from './relay-protocol'

export type StreamMetadataResponse = {
  streamId?: number
  totalSize: number
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  resultEncoding?: 'base64' | 'utf-8'
  empty?: boolean
}

export function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const code = (err as { code?: unknown }).code
  return code === JsonRpcErrorCode.MethodNotFound
}

export class StreamProtocolError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
  constructor(message: string) {
    super(message)
  }
}

// Why: exceeding a cap the caller itself set is a size verdict, not a protocol fault — callers
// translate it into their own too-large error rather than leaking the raw stream message.
export class FileReadCapExceededError extends StreamProtocolError {}
