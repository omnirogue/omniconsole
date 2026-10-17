import { StringDecoder } from 'node:string_decoder'

export const WORKTREE_METADATA_BATCH_MS = 2_000
export const WORKTREE_METADATA_INPUT_BYTES = 1024 * 1024
export const WORKTREE_METADATA_OUTPUT_BYTES = 128 * 1024
export const WORKTREE_METADATA_MAX_PATH_BYTES = 16 * 1024
export const WORKTREE_METADATA_MAX_REQUESTS = 256

export type WorktreeMetadataOperation = 'sparse' | 'exists' | 'readable'
export type WorktreeMetadataRequest = { operation: WorktreeMetadataOperation; path: string }
export type WorktreeMetadataResult =
  | { operation: 'sparse'; value: boolean }
  | { operation: 'exists'; value: true }
  | { operation: 'exists'; value: false; code: 'ENOENT' | 'ENOTDIR' }
  | { operation: 'readable'; value: true }
export type WorktreeMetadataRecord =
  | { index: number; operation: WorktreeMetadataOperation; phase: 'start' }
  | ({ index: number; phase: 'result' } & WorktreeMetadataResult)

export function isWorktreeMetadataRequest(value: unknown): value is WorktreeMetadataRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const request = value as WorktreeMetadataRequest
  return (
    ['sparse', 'exists', 'readable'].includes(request.operation) &&
    typeof request.path === 'string' &&
    request.path.length > 0 &&
    !request.path.includes('\0') &&
    Buffer.byteLength(request.path) <= WORKTREE_METADATA_MAX_PATH_BYTES
  )
}

/** Only complete, bounded, matching records may influence an advisory result. */
export function createWorktreeMetadataDecoder(
  requests: readonly WorktreeMetadataRequest[],
  accept: (record: WorktreeMetadataRecord) => void
): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  const started = new Set<number>()
  const completed = new Set<number>()
  let pending = ''
  let bytes = 0
  return (chunk) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > WORKTREE_METADATA_OUTPUT_BYTES) {
      pending = ''
      return
    }
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.length > 512) {
        continue
      }
      try {
        const record = JSON.parse(line) as WorktreeMetadataRecord
        if (
          !record ||
          !Number.isInteger(record.index) ||
          requests[record.index]?.operation !== record.operation ||
          completed.has(record.index)
        ) {
          continue
        }
        if (record.phase === 'start' && !started.has(record.index)) {
          started.add(record.index)
          accept(record)
        } else if (
          record.phase === 'result' &&
          started.has(record.index) &&
          typeof record.value === 'boolean' &&
          (record.operation === 'readable'
            ? record.value === true && !('code' in record)
            : record.operation === 'sparse' ||
              record.value === true ||
              record.code === 'ENOENT' ||
              record.code === 'ENOTDIR')
        ) {
          completed.add(record.index)
          accept(record)
        }
      } catch {
        // A broken record is unknown, never evidence that a worktree is missing.
      }
    }
    if (pending.length > 512) {
      // Discard the rest of an oversized stream rather than parse a suffix as a new record.
      bytes = WORKTREE_METADATA_OUTPUT_BYTES + 1
      pending = ''
    }
  }
}
