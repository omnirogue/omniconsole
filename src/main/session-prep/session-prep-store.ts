import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'
import {
  pruneSessionPrepBatches,
  type SessionPrepBatchRecord,
  type SessionPrepStoreFile
} from './session-prep-records'

export class SessionPrepStore {
  private batches: SessionPrepBatchRecord[] = []
  private loaded = false
  private loadTask: Promise<void> | null = null
  private inflight: Promise<void> | null = null
  private rerun = false
  private readonly file: string

  constructor(readonly directory: string) {
    this.file = join(directory, 'batches.json')
  }

  load(): Promise<void> {
    if (this.loaded) {
      return Promise.resolve()
    }
    this.loadTask ??= this.loadFromDisk()
    return this.loadTask
  }

  private async loadFromDisk(): Promise<void> {
    let loaded: SessionPrepBatchRecord[] = []
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      const batches = readStoreFile(parsed)
      if (batches) {
        loaded = batches
      } else {
        await this.quarantine()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        await this.quarantine()
      }
    }
    // Why: a request can arrive while the file is being read; keep what was added meanwhile.
    const pending = this.batches
    this.batches = loaded
    for (const batch of pending) {
      this.upsert(batch)
    }
    this.loaded = true
  }

  get(id: string): SessionPrepBatchRecord | undefined {
    return this.batches.find((batch) => batch.id === id)
  }

  list(): SessionPrepBatchRecord[] {
    return this.batches
  }

  upsert(batch: SessionPrepBatchRecord): void {
    const index = this.batches.findIndex((entry) => entry.id === batch.id)
    if (index === -1) {
      this.batches.push(batch)
    } else {
      this.batches[index] = batch
    }
  }

  persist(): Promise<void> {
    this.rerun = true
    if (this.inflight) {
      return this.inflight
    }
    this.inflight = this.flushLoop().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async flushLoop(): Promise<void> {
    while (this.rerun) {
      this.rerun = false
      await this.writeNow()
    }
  }

  private async writeNow(): Promise<void> {
    await this.load()
    this.batches = pruneSessionPrepBatches(this.batches)
    await mkdir(this.directory, { recursive: true })
    const payload: SessionPrepStoreFile = { version: 1, batches: this.batches }
    await writeFileDurable(durableWriteTempPath(this.file), this.file, JSON.stringify(payload))
  }

  private async quarantine(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await rename(this.file, join(this.directory, `batches.corrupt-${Date.now()}.json`)).catch(
      () => {}
    )
  }
}

function readStoreFile(value: unknown): SessionPrepBatchRecord[] | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const file = value as { version?: unknown; batches?: unknown }
  if (file.version !== 1 || !Array.isArray(file.batches)) {
    return null
  }
  return file.batches as SessionPrepBatchRecord[]
}
