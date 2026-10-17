import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ZodType } from 'zod'

const MAX_RECORD_BYTES = 512 * 1024

/** Main-owned recommendation records cannot be supplied through renderer run-completion writes. */
export class DecisionRecords {
  constructor(private readonly directory: string) {}

  private path(kind: 'result' | 'action', key: string): string {
    return join(this.directory, `${kind}-${createHash('sha256').update(key).digest('hex')}.json`)
  }

  async read<T>(
    kind: 'result' | 'action',
    key: string,
    schema: ZodType<T>,
    options?: { failClosed?: boolean }
  ): Promise<T | null> {
    let file: Awaited<ReturnType<typeof open>> | undefined
    let present = false
    try {
      const path = this.path(kind, key)
      const before = options?.failClosed ? await lstat(path) : null
      present = before !== null
      file = await open(
        path,
        constants.O_RDONLY |
          constants.O_NONBLOCK |
          (options?.failClosed ? constants.O_NOFOLLOW || 0 : 0)
      )
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        stat.size > MAX_RECORD_BYTES ||
        (before && (before.isSymbolicLink() || before.dev !== stat.dev || before.ino !== stat.ino))
      ) {
        throw new Error('Invalid structured decision record.')
      }
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_RECORD_BYTES || bytesRead < stat.size) {
        throw new Error('Incomplete structured decision record.')
      }
      const contents = options?.failClosed
        ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            buffer.subarray(0, bytesRead)
          )
        : buffer.subarray(0, bytesRead).toString('utf8')
      const parsed = schema.safeParse(JSON.parse(contents))
      if (!parsed.success) {
        throw new Error('Invalid structured decision record.')
      }
      if (options?.failClosed) {
        const after = await file.stat()
        const current = await lstat(path)
        if (
          bytesRead !== stat.size ||
          current.isSymbolicLink() ||
          [after, current].some(
            (entry) =>
              entry.dev !== stat.dev ||
              entry.ino !== stat.ino ||
              entry.size !== stat.size ||
              entry.mtimeMs !== stat.mtimeMs ||
              entry.ctimeMs !== stat.ctimeMs
          )
        ) {
          throw new Error('The structured decision record changed while reading.')
        }
      }
      return parsed.data
    } catch (error) {
      if (
        options?.failClosed &&
        !(
          !present &&
          file === undefined &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        throw new Error('The durable advertising action record is unavailable or invalid.')
      }
      return null
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  async write<T>(
    kind: 'result' | 'action',
    key: string,
    value: T,
    schema: ZodType<T>
  ): Promise<void> {
    const bytes = JSON.stringify(schema.parse(value))
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) {
      throw new Error('Structured decision record exceeds its size limit.')
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const destination = this.path(kind, key)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, destination)
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}
