import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

function sameRegularFile(expected: Stats, actual: Stats): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  )
}

/** A completed temporary file is promoted without replacing a competing destination. */
export async function writeExclusiveFile(
  destination: string,
  bytes: Buffer,
  options: {
    validateDestinationParent?: () => Promise<unknown>
    temporaryDirectory?: string
    validateTemporaryParent?: () => Promise<unknown>
  } = {}
): Promise<void> {
  const validateDestination = options.validateDestinationParent ?? (async () => undefined)
  const validateTemporary = options.validateTemporaryParent ?? validateDestination
  await validateDestination()
  await validateTemporary()
  const temporary = join(
    options.temporaryDirectory ?? dirname(destination),
    `.${basename(destination)}.${randomUUID()}.omni-tmp`
  )
  const handle = await open(temporary, 'wx', 0o600)
  let identity: Stats | undefined
  try {
    try {
      identity = await handle.stat()
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await validateDestination()
    await validateTemporary()
    if (!sameRegularFile(identity, await lstat(temporary))) {
      throw new Error('The temporary destination changed during the transfer.')
    }
    // Node path checks narrow ancestor-replacement races; they are not descriptor-relative I/O.
    await link(temporary, destination)
    await validateDestination()
    if (!sameRegularFile(identity, await lstat(destination))) {
      throw new Error('The destination changed during the transfer.')
    }
  } finally {
    if (identity) {
      await validateTemporary()
      const current = await lstat(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null
        }
        throw error
      })
      if (current && sameRegularFile(identity, current)) {
        await unlink(temporary)
      }
    }
  }
}
