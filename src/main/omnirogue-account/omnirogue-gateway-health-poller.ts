import {
  FALLBACK_GATEWAY_MODELS,
  type OmniRogueGatewayProvider
} from '../../shared/omnirogue-account'
import type { RoomErrorCode } from '../../shared/rooms'
import { RoomError, roomErrorCode } from '../rooms/room-error'
import { getOmniRogueGatewayModels } from './omnirogue-gateway-models'

export type OmniRogueGatewayHealthState =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unauthorized'
  | 'unreachable'

export type OmniRogueGatewayHealthSnapshot = {
  state: OmniRogueGatewayHealthState
  checkedAt: number | null
  latencyMs: number | null
  modelCount: number
  providers: OmniRogueGatewayProvider[]
  missingProviders: OmniRogueGatewayProvider[]
  consecutiveFailures: number
  nextCheckMs: number | null
  error?: RoomErrorCode
}

export type OmniRogueGatewayHealthPollerOptions = {
  /** Authenticated gateway read, e.g. the shared account lease's `request`. */
  request: (path: string) => Promise<unknown>
  publish: (snapshot: OmniRogueGatewayHealthSnapshot) => void
  intervalMs?: number
  retryBaseMs?: number
  maxBackoffMs?: number
  timeoutMs?: number
  now?: () => number
}

const PROVIDERS: readonly OmniRogueGatewayProvider[] = ['anthropic', 'openai', 'google']
const UNAUTHORIZED: readonly RoomErrorCode[] = ['device_unauthorized', 'forbidden']

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.max(min, Math.min(Number.isFinite(value) ? (value as number) : fallback, max))

export function initialGatewayHealthSnapshot(): OmniRogueGatewayHealthSnapshot {
  return {
    state: 'unknown',
    checkedAt: null,
    latencyMs: null,
    modelCount: 0,
    providers: [],
    missingProviders: [],
    consecutiveFailures: 0,
    nextCheckMs: null
  }
}

/** Polls the gateway model catalog while started; failures back off exponentially. */
export class OmniRogueGatewayHealthPoller {
  private snapshot = initialGatewayHealthSnapshot()
  private running = false
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private inFlight: {
    generation: number
    promise: Promise<OmniRogueGatewayHealthSnapshot>
  } | null = null
  private readonly intervalMs: number
  private readonly retryBaseMs: number
  private readonly maxBackoffMs: number
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(private readonly options: OmniRogueGatewayHealthPollerOptions) {
    this.intervalMs = clamp(options.intervalMs, 60_000, 1_000, 3_600_000)
    this.retryBaseMs = clamp(options.retryBaseMs, 5_000, 250, this.intervalMs)
    this.maxBackoffMs = clamp(options.maxBackoffMs, 300_000, this.retryBaseMs, 3_600_000)
    this.timeoutMs = clamp(options.timeoutMs, 10_000, 100, 60_000)
    this.now = options.now ?? Date.now
  }

  current(): OmniRogueGatewayHealthSnapshot {
    return structuredClone(this.snapshot)
  }

  isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    this.generation++
    void this.checkNow()
  }

  stop(): void {
    if (!this.running) {
      return
    }
    this.running = false
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
    this.snapshot.nextCheckMs = null
  }

  /** Runs a probe now, coalescing with one already in flight. */
  checkNow(): Promise<OmniRogueGatewayHealthSnapshot> {
    // A probe from before stop()/start() must not absorb the new generation's check.
    if (this.inFlight?.generation === this.generation) {
      return this.inFlight.promise
    }
    clearTimeout(this.timer)
    this.timer = undefined
    const generation = this.generation
    const entry = {
      generation,
      promise: this.probe()
        .then((next) => {
          if (generation !== this.generation) {
            return this.current()
          }
          this.snapshot = next
          if (this.running) {
            this.timer = setTimeout(() => void this.checkNow(), next.nextCheckMs ?? this.intervalMs)
          } else {
            this.snapshot.nextCheckMs = null
          }
          try {
            this.options.publish(this.current())
          } catch {
            // A failing listener must not stop polling.
          }
          return this.current()
        })
        .finally(() => {
          if (this.inFlight === entry) {
            this.inFlight = null
          }
        })
    }
    this.inFlight = entry
    return entry.promise
  }

  dispose(): void {
    this.stop()
    this.snapshot = initialGatewayHealthSnapshot()
  }

  private async probe(): Promise<OmniRogueGatewayHealthSnapshot> {
    const started = this.now()
    let failure: unknown = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RoomError('timeout')), this.timeoutMs)
    })
    let models: Awaited<ReturnType<typeof getOmniRogueGatewayModels>>
    try {
      // Reuse catalog parsing; capture the request error the parser swallows.
      models = await Promise.race([
        getOmniRogueGatewayModels(async (path) => {
          try {
            return await this.options.request(path)
          } catch (error) {
            failure = error
            throw error
          }
        }),
        timeout
      ])
    } catch (error) {
      failure = error
      models = FALLBACK_GATEWAY_MODELS
    } finally {
      clearTimeout(timer)
    }
    const checkedAt = this.now(),
      latencyMs = Math.max(0, checkedAt - started)
    if (failure !== null) {
      const error = roomErrorCode(failure),
        consecutiveFailures = this.snapshot.consecutiveFailures + 1
      return {
        ...initialGatewayHealthSnapshot(),
        state: UNAUTHORIZED.includes(error) ? 'unauthorized' : 'unreachable',
        checkedAt,
        latencyMs,
        consecutiveFailures,
        nextCheckMs: Math.min(
          this.maxBackoffMs,
          this.retryBaseMs * 2 ** Math.min(consecutiveFailures - 1, 10)
        ),
        error
      }
    }
    // The parser returns the fallback list by identity when the live catalog is unusable.
    const live = models !== FALLBACK_GATEWAY_MODELS ? models : []
    const providers = PROVIDERS.filter((provider) =>
      live.some((model) => model.provider === provider)
    )
    const missingProviders = PROVIDERS.filter((provider) => !providers.includes(provider))
    return {
      state: missingProviders.length ? 'degraded' : 'healthy',
      checkedAt,
      latencyMs,
      modelCount: live.length,
      providers,
      missingProviders,
      consecutiveFailures: 0,
      nextCheckMs: this.intervalMs,
      ...(live.length ? {} : { error: 'invalid_response' as const })
    }
  }
}
