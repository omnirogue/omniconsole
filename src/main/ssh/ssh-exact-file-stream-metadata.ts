import type { FileExactReadIdentity } from '../../shared/exact-file-read-identity'
import type { FileReadResult } from '../providers/types'
import { StreamProtocolError, type StreamMetadataResponse } from './ssh-file-stream-contract'

export function fileStreamReadResult(
  content: string,
  metadata: Pick<StreamMetadataResponse, 'isBinary' | 'isImage' | 'mimeType'>
): FileReadResult {
  return {
    content,
    isBinary: metadata.isBinary,
    ...(metadata.isImage !== undefined ? { isImage: metadata.isImage } : {}),
    ...(metadata.mimeType !== undefined ? { mimeType: metadata.mimeType } : {})
  }
}

export function exactFileStreamMetadataError(
  metadata: StreamMetadataResponse,
  method: 'fs.readFileStream' | 'fs.readExactFileStream',
  expectedIdentity?: FileExactReadIdentity
): StreamProtocolError | undefined {
  if (
    expectedIdentity !== undefined &&
    (!Number.isSafeInteger(metadata.totalSize) ||
      metadata.totalSize < 0 ||
      metadata.totalSize !== expectedIdentity.size ||
      (metadata.empty && metadata.totalSize !== 0))
  ) {
    return new StreamProtocolError('The host did not provide the exact source file size.')
  }
  if (
    method === 'fs.readExactFileStream' &&
    (metadata.isBinary !== true || metadata.resultEncoding !== 'base64')
  ) {
    return new StreamProtocolError('The host did not provide exact binary file bytes.')
  }
  return undefined
}
