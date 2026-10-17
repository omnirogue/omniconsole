import { appendFile, chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LocalFileSinkOptions } from './local-file-sink'

export type AsyncLocalFileSink = { push(record: unknown): void; flush(): Promise<void> }

/** Ordered, bounded append queue; diagnostics never wait on the spawn path. */
export function createAsyncLocalFileSink(
  options: LocalFileSinkOptions & { warnLabel?: string }
): AsyncLocalFileSink {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 10
  let chain = Promise.resolve()
  let bytes: number | null = null
  let queuedBytes = 0
  let warned = false
  const warn = () => {
    if (!warned) {
      warned = true
      console.warn(`[${options.warnLabel ?? 'launch-ledger'}] asynchronous write unavailable`)
    }
  }
  async function append(line: string, size: number): Promise<void> {
    if (bytes === null) {
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 })
      bytes = await stat(options.filePath).then(
        (file) => file.size,
        (error) => {
          if (error.code !== 'ENOENT') {
            throw error
          }
          return 0
        }
      )
      await chmod(options.filePath, 0o600).catch((error) => {
        if (error.code !== 'ENOENT' && process.platform !== 'win32') {
          throw error
        }
      })
    }
    if (bytes > 0 && bytes + size > maxBytes) {
      for (let index = maxFiles - 1; index >= 1; index--) {
        const source = index === 1 ? options.filePath : `${options.filePath}.${index - 1}`
        const target = `${options.filePath}.${index}`
        await rm(target, { force: true })
        await rename(source, target).catch((error) => {
          if (error.code !== 'ENOENT') {
            throw error
          }
        })
      }
      if (maxFiles === 1) {
        await rm(options.filePath, { force: true })
      }
      bytes = 0
    }
    await appendFile(options.filePath, line, { encoding: 'utf8', mode: 0o600 })
    bytes += size
  }
  return {
    push(record) {
      try {
        const line = `${JSON.stringify(record)}\n`
        const size = Buffer.byteLength(line, 'utf8')
        if (size > maxBytes || queuedBytes + size > maxBytes * maxFiles) {
          warn()
          return
        }
        queuedBytes += size
        chain = chain
          .then(() => append(line, size))
          .catch(() => {
            bytes = null
            warn()
          })
          .finally(() => {
            queuedBytes -= size
          })
      } catch {
        warn()
      }
    },
    async flush() {
      let draining: Promise<void>
      do {
        draining = chain
        await draining
      } while (chain !== draining)
    }
  }
}
