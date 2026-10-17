import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const TAIL_BYTES = 256 * 1024
const CACHE_LIMIT = 256

/** Host ticks read only complete records and cache unchanged provider files. */
export function createProviderTranscriptTailReader<T>(parse: (content: string) => T) {
  const cache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; result: T }>()
  return (path: string): T | null => {
    let fd: number | null = null
    try {
      fd = openSync(path, 'r')
      const stats = fstatSync(fd)
      if (!stats.isFile()) {
        return null
      }
      const cached = cache.get(path)
      if (
        cached &&
        cached.size === stats.size &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.ctimeMs === stats.ctimeMs
      ) {
        return cached.result
      }
      const start = Math.max(0, stats.size - TAIL_BYTES)
      const buffer = Buffer.alloc(stats.size - start)
      const read = readSync(fd, buffer, 0, buffer.length, start)
      let content = buffer.subarray(0, read).toString('utf8')
      const after = fstatSync(fd)
      if (read !== buffer.length || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
        return null
      }
      if (!content.endsWith('\n')) {
        return null
      }
      if (start > 0) {
        content = content.slice(content.indexOf('\n') + 1)
      }
      const result = parse(content)
      if (cache.size >= CACHE_LIMIT) {
        cache.clear()
      }
      cache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, result })
      return result
    } catch {
      return null
    } finally {
      if (fd !== null) {
        closeSync(fd)
      }
    }
  }
}
