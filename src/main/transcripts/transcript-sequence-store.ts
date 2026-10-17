import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FILE_NAME = 'session-sync-sequences.json'

/**
 * The upload sequence per (agent, provider session id), kept across pane
 * lifetimes and app restarts (key `agent|sessionId`). The hub refuses an older `seq` with 409
 * stale_snapshot, so a resumed session that restarted at 1 would have every
 * later upload refused — and the refusal reads as success. Atomic write:
 * temp file then rename, so a cut-short write leaves the old file intact.
 */
export class TranscriptSequenceStore {
  private entries = new Map<string, number>()
  private loaded: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(private readonly directory: string | null) {}

  private key(agent: string, sessionId: string): string {
    return `${agent}|${sessionId}`
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.directory) {
        return
      }
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.directory, FILE_NAME), 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
              this.entries.set(key, value)
            }
          }
        }
      } catch {
        // Why: no file yet, or an unreadable one, both mean "start from 1".
      }
    })()
    return this.loaded
  }

  /** The sequence the next upload should carry (last + 1). */
  peek(agent: string, sessionId: string): number {
    return (this.entries.get(this.key(agent, sessionId)) ?? 0) + 1
  }

  /** Record a sequence as used; persists in the background. */
  commit(agent: string, sessionId: string, seq: number): void {
    const key = this.key(agent, sessionId)
    if ((this.entries.get(key) ?? 0) >= seq) {
      return
    }
    // Why no cap: an evicted session would restart at 1 and be refused as stale
    // forever; the entries are a few dozen bytes each.
    this.entries.set(key, seq)
    this.dirty = true
    this.writing = this.writing.then(() => this.persist()).catch(() => undefined)
  }

  flush(): Promise<void> {
    return this.writing
  }

  private async persist(): Promise<void> {
    if (!this.dirty || !this.directory) {
      return
    }
    this.dirty = false
    const path = join(this.directory, FILE_NAME)
    const temp = `${path}.${process.pid}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, JSON.stringify(Object.fromEntries(this.entries)))
    await rename(temp, path)
  }
}
