import { stat } from 'node:fs/promises'
import { detectSparseCheckout } from './worktree-sparse-state'
import { probeWorktreeReadable } from './worktree-readable-probe'
import {
  isWorktreeMetadataRequest,
  WORKTREE_METADATA_BATCH_MS,
  WORKTREE_METADATA_INPUT_BYTES,
  WORKTREE_METADATA_MAX_REQUESTS
} from './worktree-metadata-protocol'
import type {
  WorktreeMetadataRecord,
  WorktreeMetadataRequest,
  WorktreeMetadataResult
} from './worktree-metadata-protocol'

// Only this process owns potentially uninterruptible worktree filesystem calls.
const CONCURRENCY = 4
const chunks: Buffer[] = []
let inputBytes = 0
let stopping = false

function finish(): void {
  if (stopping) {
    return
  }
  stopping = true
  process.stdout.write('', () => process.exit(0))
}

setTimeout(finish, WORKTREE_METADATA_BATCH_MS - 250)
setTimeout(() => process.exit(0), WORKTREE_METADATA_BATCH_MS - 100)
process.stdout.on('error', () => process.exit(1))
process.stdin.on('error', () => process.exit(1))
process.stdin.on('data', (chunk: Buffer) => {
  inputBytes += chunk.length
  if (inputBytes > WORKTREE_METADATA_INPUT_BYTES) {
    process.exit(64)
  }
  chunks.push(chunk)
})

function emit(record: WorktreeMetadataRecord): void {
  if (!stopping) {
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }
}

async function probe(
  request: WorktreeMetadataRequest
): Promise<WorktreeMetadataResult | undefined> {
  if (request.operation === 'readable') {
    return (await probeWorktreeReadable(request.path))
      ? { operation: 'readable', value: true }
      : undefined
  }
  if (request.operation === 'sparse') {
    return { operation: 'sparse', value: await detectSparseCheckout(request.path) }
  }
  try {
    await stat(request.path)
    return { operation: 'exists', value: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { operation: 'exists', value: false, code }
      : undefined
  }
}

process.stdin.on('end', () => {
  let requests: WorktreeMetadataRequest[]
  try {
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (
      !Array.isArray(input) ||
      input.length > WORKTREE_METADATA_MAX_REQUESTS ||
      !input.every(isWorktreeMetadataRequest)
    ) {
      process.exit(64)
    }
    requests = input
  } catch {
    process.exit(64)
  }
  chunks.length = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (!stopping && next < requests.length) {
      const index = next++
      const request = requests[index]
      emit({ index, operation: request.operation, phase: 'start' })
      const result = await probe(request)
      if (result) {
        emit({ index, phase: 'result', ...result })
      }
    }
  }
  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, worker)).then(
    finish,
    finish
  )
})
