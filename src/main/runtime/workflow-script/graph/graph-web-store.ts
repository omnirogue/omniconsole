import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { WEB_PAGE_MAX_BYTES } from '../../../web-pages/web-page-response'
import { graphExecutionFolder } from './graph-jev-store'

const SHA256 = /^[0-9a-f]{64}$/

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * A run's fetched pages, content-addressed (`<execution>/web/<sha256>.txt|.raw.gz`). A blob is
 * written once and never changed, so a replay proves each page by re-hashing it.
 */
export class GraphWebStore {
  constructor(private readonly folder: string) {}

  static forExecution(executionId: string, root?: string): GraphWebStore {
    return new GraphWebStore(join(graphExecutionFolder(executionId, root), 'web'))
  }

  /** Keeps a page's clean text; returns the hash it is stored under. */
  putText(text: string): string {
    const bytes = Buffer.from(text, 'utf8')
    const hash = sha256(bytes)
    this.put(`${hash}.txt`, bytes)
    return hash
  }

  /** Keeps what the site sent (decompressed), gzipped; returns the hash of the body itself. */
  putRaw(raw: Uint8Array): string {
    const hash = sha256(raw)
    this.put(`${hash}.raw.gz`, gzipSync(raw))
    return hash
  }

  /** The text kept under `hash`, or undefined when it is missing or no longer hashes to it. */
  text(hash: string): string | undefined {
    const bytes = this.read(hash, 'txt')
    return bytes && sha256(bytes) === hash ? bytes.toString('utf8') : undefined
  }

  /** Whether the body kept under `hash` is still there and still hashes to it. */
  hasRaw(hash: string): boolean {
    const packed = this.read(hash, 'raw.gz')
    if (!packed) {
      return false
    }
    try {
      // Capped like the fetch itself: a swapped-in bomb is a changed blob, not a hang.
      return sha256(gunzipSync(packed, { maxOutputLength: WEB_PAGE_MAX_BYTES })) === hash
    } catch {
      return false
    }
  }

  private read(hash: string, kind: 'txt' | 'raw.gz'): Buffer | undefined {
    if (!SHA256.test(hash)) {
      return undefined
    }
    try {
      return readFileSync(join(this.folder, `${hash}.${kind}`))
    } catch {
      return undefined
    }
  }

  private put(name: string, data: Uint8Array): void {
    const file = join(this.folder, name)
    if (existsSync(file)) {
      return
    }
    mkdirSync(this.folder, { recursive: true, mode: 0o700 })
    const temporary = join(this.folder, `${randomBytes(8).toString('hex')}.tmp`)
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}
