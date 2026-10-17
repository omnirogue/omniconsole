/**
 * This Mac's view of every computer's resources: the local reading and one `sessionHost.hostStats`
 * per paired or SSH host. Answers with what it knows after a short wait and keeps slower hosts
 * reading in the background, so an unreachable computer never holds up the others.
 */

import type { HostResourceReading } from '../../shared/host-resource-model'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

/** The renderer polls this often while a surface shows host resources. */
export const HOST_RESOURCE_POLL_MS = 30_000
/** Younger readings are reused, so each 30 s poll reads every host once. */
const HOST_RESOURCE_FRESH_MS = 20_000
const HOST_READ_TIMEOUT_MS = 8_000
const ANSWER_WAIT_MS = 3_000
const READ_CONCURRENCY = 3
export const MAX_HOST_RESOURCE_KEYS = 32

export type HostResourceAnswer = Omit<HostResourceReading, 'hostKey' | 'readAt'>

export type HostResourceReaderDeps = {
  readLocal(): Promise<HostResourceAnswer>
  readRemote(hostKey: string): Promise<HostResourceAnswer>
  now(): number
  answerWaitMs?: number
  readTimeoutMs?: number
}

function unavailable(detail: string): HostResourceAnswer {
  return { state: 'unavailable', detail, memory: null, liveSessions: null }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class HostResourceReader {
  private readonly known = new Map<string, HostResourceReading>()
  private readonly reading = new Map<string, Promise<void>>()

  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly deps: HostResourceReaderDeps) {}

  private async readOne(hostKey: string): Promise<void> {
    const read = Promise.resolve()
      .then(() =>
        hostKey === LOCAL_EXECUTION_HOST_ID ? this.deps.readLocal() : this.deps.readRemote(hostKey)
      )
      .catch((error: unknown) =>
        unavailable(error instanceof Error ? error.message : String(error))
      )
      .then((answer) => {
        this.known.set(hostKey, { ...answer, hostKey, readAt: this.deps.now() })
      })
      .finally(() => this.inFlight.delete(hostKey))
    // Keep the actual read, since a timeout only abandons our wait.
    this.inFlight.set(hostKey, read)
    await withTimeout(read, this.deps.readTimeoutMs ?? HOST_READ_TIMEOUT_MS, () => {
      if (!this.known.has(hostKey)) {
        this.known.set(hostKey, {
          ...unavailable('That computer did not answer in time.'),
          hostKey,
          readAt: this.deps.now()
        })
      }
    })
  }

  private isFresh(hostKey: string): boolean {
    const readAt = this.known.get(hostKey)?.readAt ?? null
    return readAt !== null && this.deps.now() - readAt < HOST_RESOURCE_FRESH_MS
  }

  /** One reading per key: fresh ones reused, stale ones re-read a few at a time. */
  async read(hostKeys: readonly string[]): Promise<HostResourceReading[]> {
    const keys = [...new Set(hostKeys)].slice(0, MAX_HOST_RESOURCE_KEYS)
    const due = keys.filter(
      (key) => !this.isFresh(key) && !this.reading.has(key) && !this.inFlight.has(key)
    )
    if (due.length > 0) {
      const batch = mapWithConcurrency(due, READ_CONCURRENCY, async (key) => {
        await this.readOne(key)
        this.reading.delete(key)
      })
      for (const key of due) {
        this.reading.set(
          key,
          batch.then(() => undefined)
        )
      }
    }
    const pending = keys.flatMap((key) => {
      const inFlight = this.reading.get(key)
      return inFlight ? [inFlight] : []
    })
    if (pending.length > 0) {
      await withTimeout(
        Promise.all(pending).then(() => undefined),
        this.deps.answerWaitMs ?? ANSWER_WAIT_MS,
        () => undefined
      )
    }
    return keys.map(
      (hostKey) =>
        this.known.get(hostKey) ?? {
          hostKey,
          state: 'checking',
          readAt: null,
          memory: null,
          liveSessions: null
        }
    )
  }
}
