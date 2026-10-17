import { existsSync, readFileSync } from 'node:fs'
import type { Store } from '../persistence'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import { loadKnownUsageWorktreesByRepo } from '../usage-worktree-metadata'
import type { UsageScanOptions, UsageScanWorktreeRef } from './usage-provider-contract'
import { createWorktreeRefs, getUsageWorktreeFingerprint } from './usage-worktree-refs'
import { UsageScanStoppedError } from './usage-scan-stopped-error'

const STALE_MS = 5 * 60_000

type UsageProviderScanState = {
  enabled: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
}

type UsageProviderStoreState<SourceKey extends string> = {
  worktreeFingerprint: string | null
  sessions: unknown[]
  dailyAggregates: unknown[]
  scanState: UsageProviderScanState
} & Record<SourceKey, unknown[]>

type UsageProviderScanProjection<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>
> = Pick<State, SourceKey | 'sessions' | 'dailyAggregates'>

type UsageProviderStoreLifecycleConfig<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> = {
  logTag: string
  resolveCacheFile: () => string
  createDefaultState: () => State
  normalizeState: (state: State) => State
  sourceKey: SourceKey
  dataPresenceKey: DataPresenceKey
  jsonIndent?: number
  scan: (
    worktrees: UsageScanWorktreeRef[],
    previous: State[SourceKey],
    options?: UsageScanOptions<State[SourceKey][number]>
  ) => Promise<UsageProviderScanProjection<SourceKey, State>>
  /** The scan re-checks each cached source's worktree attribution itself, so a worktree-list
   *  change hands it the cache instead of discarding it, and it may checkpoint settled sources. */
  scanRevalidatesWorktreeAttribution?: boolean
}

type PublicUsageProviderScanState<DataPresenceKey extends string> = UsageProviderScanState & {
  isScanning: boolean
} & Record<DataPresenceKey, boolean>

export abstract class UsageProviderStoreLifecycle<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> {
  protected state: State
  private scanPromise: Promise<void> | null = null
  private stopGeneration = 0
  private readonly writer: UsageCacheSnapshotWriter

  constructor(
    private readonly store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
    private readonly config: UsageProviderStoreLifecycleConfig<SourceKey, State, DataPresenceKey>
  ) {
    this.writer = new UsageCacheSnapshotWriter(config.logTag, config.resolveCacheFile)
    this.state = this.load()
  }

  getScanState(): PublicUsageProviderScanState<DataPresenceKey> {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      [this.config.dataPresenceKey]:
        this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
    } as PublicUsageProviderScanState<DataPresenceKey>
  }

  /** Await queued cache writes so quit does not drop the final snapshot. */
  flush(): Promise<void> {
    return this.writer.flush()
  }

  async setEnabled(enabled: boolean): Promise<PublicUsageProviderScanState<DataPresenceKey>> {
    if (!enabled) {
      this.stopGeneration += 1
    }
    this.state.scanState.enabled = enabled
    await this.writeToDisk()
    return this.getScanState()
  }

  async refresh(force = false): Promise<PublicUsageProviderScanState<DataPresenceKey>> {
    if (!this.state.scanState.enabled) {
      return this.getScanState()
    }
    const currentWorktreeFingerprint = await this.getCurrentWorktreeFingerprint()
    if (!force && this.state.scanState.lastScanCompletedAt) {
      const ageMs = Date.now() - this.state.scanState.lastScanCompletedAt
      if (ageMs < STALE_MS && this.state.worktreeFingerprint === currentWorktreeFingerprint) {
        return this.getScanState()
      }
    }
    await this.runScan()
    return this.getScanState()
  }

  protected writeToDisk(): Promise<void> {
    return this.writer.write(() => JSON.stringify(this.state, null, this.config.jsonIndent))
  }

  private load(): State {
    const defaults = this.config.createDefaultState()
    try {
      const cacheFile = this.config.resolveCacheFile()
      if (!existsSync(cacheFile)) {
        return defaults
      }
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf-8')) as State
      return this.config.normalizeState({
        ...defaults,
        ...parsed,
        scanState: { ...defaults.scanState, ...parsed.scanState }
      })
    } catch (error) {
      console.error(`${this.config.logTag} Failed to load persisted state, starting fresh:`, error)
      return defaults
    }
  }

  private async runScan(): Promise<void> {
    if (this.scanPromise) {
      await this.scanPromise
      return
    }

    this.state.scanState.lastScanStartedAt = Date.now()
    this.state.scanState.lastScanError = null

    const stopGeneration = this.stopGeneration
    const shouldStop = (): boolean =>
      !this.state.scanState.enabled || this.stopGeneration !== stopGeneration

    // Assign before yielding so concurrent refreshes share one scan.
    this.scanPromise = (async () => {
      try {
        const repos = this.store.getRepos()
        const worktreesByRepo = loadKnownUsageWorktreesByRepo(this.store, repos)
        const worktreeFingerprint = getUsageWorktreeFingerprint(worktreesByRepo)
        const worktreeSetChanged = this.state.worktreeFingerprint !== worktreeFingerprint
        const worktreeRefs = createWorktreeRefs(repos, worktreesByRepo)
        const result = this.config.scanRevalidatesWorktreeAttribution
          ? await this.config.scan(worktreeRefs, this.state[this.config.sourceKey], {
              worktreeSetChanged,
              checkpointState: {
                ...this.state,
                [this.config.sourceKey]: [],
                worktreeFingerprint
              },
              onSerializedCheckpoint: (snapshot) =>
                shouldStop() ? Promise.resolve() : this.writer.write(() => snapshot),
              // Why: persist settled sources only; sessions and scan times stay as last completed.
              onCheckpoint: (sources) =>
                this.writer.write(() =>
                  JSON.stringify(
                    { ...this.state, [this.config.sourceKey]: sources, worktreeFingerprint },
                    null,
                    this.config.jsonIndent
                  )
                ),
              // Why: turning tracking off must end a long scan now, not when it finishes.
              shouldStop
            })
          : await this.config.scan(
              worktreeRefs,
              worktreeSetChanged
                ? this.config.createDefaultState()[this.config.sourceKey]
                : this.state[this.config.sourceKey]
            )
        if (shouldStop()) {
          throw new UsageScanStoppedError('Usage scan stopped')
        }
        this.state[this.config.sourceKey] = result[this.config.sourceKey]
        this.state.sessions = result.sessions
        this.state.dailyAggregates = result.dailyAggregates
        this.state.worktreeFingerprint = worktreeFingerprint
        this.state.scanState.lastScanCompletedAt = Date.now()
        this.state.scanState.lastScanError = null
        // Persistence failures do not turn a successful source scan into a scan failure.
        await this.writeToDisk().catch(() => {})
      } catch (error) {
        if (error instanceof UsageScanStoppedError) {
          return
        }
        this.state.scanState.lastScanError = error instanceof Error ? error.message : String(error)
        await this.writeToDisk().catch(() => {})
      } finally {
        this.scanPromise = null
      }
    })()

    await this.scanPromise
  }

  private async getCurrentWorktreeFingerprint(): Promise<string> {
    const repos = this.store.getRepos()
    return getUsageWorktreeFingerprint(loadKnownUsageWorktreesByRepo(this.store, repos))
  }
}
