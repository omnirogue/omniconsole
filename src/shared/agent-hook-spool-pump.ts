import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { drainAgentHookSpool, type SpoolDrainOptions } from './agent-hook-spool'

/** One runtime owns delivery; producers only append to its existing private spool. */
export class AgentHookSpoolPump {
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private fallback?: ReturnType<typeof setInterval>
  private pending: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly options: SpoolDrainOptions,
    private readonly onError: (error: unknown) => void
  ) {}

  start(): boolean {
    try {
      const directory = join(this.options.endpointDir, 'spool')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      this.watcher = watch(directory, { persistent: false }, () => this.schedule())
      this.watcher.on('error', this.onError)
      this.fallback = setInterval(() => this.schedule(), 1000)
      this.fallback.unref()
      return true
    } catch (error) {
      this.onError(error)
      this.stop()
      return false
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(this.onError)
    }, 10)
    this.timer.unref()
  }

  flush(): Promise<void> {
    const operation = this.pending.then(async () => {
      if (!this.stopped) {
        await drainAgentHookSpool(this.options)
      }
    })
    this.pending = operation.catch(() => {})
    return operation
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    if (this.timer) {
      clearTimeout(this.timer)
    }
    if (this.fallback) {
      clearInterval(this.fallback)
    }
  }
}
