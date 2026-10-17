import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { readNodeFileHandleWithinLimit } from './node-bounded-file-reader'
import {
  HANDOFF_FILE_MAX_BYTES,
  exactHandoffFile,
  exactHandoffThreadFile,
  type ExactHandoffFile
} from './console-handoff-contract'

export function capturedHandoffFile(
  name: string,
  bytes: Buffer,
  threadUpload = false
): ExactHandoffFile {
  return (threadUpload ? exactHandoffThreadFile : exactHandoffFile).parse({
    name,
    size: bytes.length,
    contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex')
  })
}

/** A selected file is a bounded original byte snapshot, never a preview or extracted text. */
export async function readExactHandoffFile(filePath: string): Promise<ExactHandoffFile> {
  const canonical = await realpath(filePath)
  const handle = await open(
    canonical,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
  )
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw new Error('Choose a regular file.')
    }
    const { buffer } = await readNodeFileHandleWithinLimit(handle, HANDOFF_FILE_MAX_BYTES)
    const after = await handle.stat()
    const current = await stat(canonical)
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== buffer.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('The file changed while reading. Select it again.')
    }
    return capturedHandoffFile(basename(filePath), buffer)
  } finally {
    await handle.close()
  }
}
