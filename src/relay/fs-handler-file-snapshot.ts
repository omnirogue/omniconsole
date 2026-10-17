import { constants, type Stats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { FileExactReadIdentity } from '../shared/exact-file-read-identity'

export function parseExactFileReadIdentity(value: unknown): FileExactReadIdentity | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Choose a valid source file identity.')
  }
  const identity = value as Record<string, unknown>
  for (const key of ['dev', 'ino', 'size', 'mode']) {
    if (!Number.isSafeInteger(identity[key]) || (identity[key] as number) < 0) {
      throw new Error('Choose a valid source file identity.')
    }
  }
  for (const key of ['mtimeMs', 'ctimeMs']) {
    if (typeof identity[key] !== 'number' || !Number.isFinite(identity[key])) {
      throw new Error('Choose a valid source file identity.')
    }
  }
  return {
    dev: identity.dev as number,
    ino: identity.ino as number,
    size: identity.size as number,
    mode: identity.mode as number,
    mtimeMs: identity.mtimeMs as number,
    ctimeMs: identity.ctimeMs as number
  }
}

export function assertExactFileReadIdentity(current: Stats, expected: FileExactReadIdentity): void {
  if (
    !current.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs ||
    current.mode !== expected.mode
  ) {
    throw new Error('The file changed while reading. Select it again.')
  }
}

export async function assertExactRelayFile(
  handle: FileHandle,
  expected: FileExactReadIdentity
): Promise<void> {
  assertExactFileReadIdentity(await handle.stat(), expected)
}

export async function openExactRelayFile(
  filePath: string,
  expected: Stats,
  selectedIdentity?: FileExactReadIdentity
): Promise<FileHandle> {
  const handle = await open(
    filePath,
    constants.O_RDONLY |
      (constants.O_NONBLOCK || 0) |
      (selectedIdentity ? constants.O_NOFOLLOW || 0 : 0)
  )
  try {
    await assertExactRelayFile(handle, expected)
    if (selectedIdentity) {
      await assertExactRelayFile(handle, selectedIdentity)
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
