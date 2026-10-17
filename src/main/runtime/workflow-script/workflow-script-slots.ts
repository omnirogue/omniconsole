import { availableParallelism } from 'node:os'

export const WORKFLOW_SCRIPT_MAX_SLOTS = 16

/** Agents that may run at once on this host: the Workflow tool's own rule, min(16, cores − 2). */
export function defaultWorkflowScriptSlots(cores = availableParallelism()): number {
  return Math.max(1, Math.min(WORKFLOW_SCRIPT_MAX_SLOTS, cores - 2))
}

/**
 * A slot is taken before the work is awaited and given back when it settles, so a burst of
 * `agent()` calls queues behind the cap instead of launching everything at once.
 */
export class WorkflowScriptSlots {
  private active = 0
  private readonly waiting: { grant: () => void; cancel: () => void }[] = []

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('slot limit must be a positive integer')
    }
  }

  get running(): number {
    return this.active
  }

  get queued(): number {
    return this.waiting.length
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', waiter.cancel)
          resolve()
        },
        cancel: () => {
          const index = this.waiting.indexOf(waiter)
          if (index !== -1) {
            this.waiting.splice(index, 1)
            signal?.removeEventListener('abort', waiter.cancel)
            reject(signal?.reason)
          }
        }
      }
      this.waiting.push(waiter)
      signal?.addEventListener('abort', waiter.cancel, { once: true })
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) {
      // Transfer the occupied slot before waking a waiter so a new caller cannot steal it.
      next.grant()
    } else {
      this.active -= 1
    }
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      signal?.throwIfAborted()
      return await work()
    } finally {
      this.release()
    }
  }
}
