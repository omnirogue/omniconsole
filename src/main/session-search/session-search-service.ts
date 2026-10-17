import {
  spawnProcess,
  type ChildProcessHandle as ChildProcess
} from '../../shared/child-process/run-process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { localHostLabel } from '../local-host-label'
import { buildAiVaultServiceEnv } from '../ai-vault/session-scanner-service-env'
import { lowerAiVaultServicePriority } from '../ai-vault/session-scanner-service-priority'
import { startSessionSummaries, type SessionSummaryDeps } from './session-summary-scheduler'
import { startWorkFeedPublisher } from '../work-feed/work-feed-publisher'
import {
  SESSION_SEARCH_SERVICE_PROTOCOL,
  isSessionSearchChildMessage,
  type SessionSearchFeedRow,
  type SessionSearchServiceOperation,
  type SessionSearchServiceSearchValue,
  type SessionSearchServiceStatus,
  type SessionSearchSummaryCandidate
} from './session-search-service-protocol'

const ENTRY_NAME = 'session-search-service-entry.js'
const START_DELAY_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const READY_TIMEOUT_MS = 20_000
const RESTART_BASE_MS = 15_000
const RESTART_MAX_MS = 10 * 60_000
const MAX_QUICK_FAILURES = 5
/** Half the wall time at below-normal priority: a backfill never competes with live sessions. */
const DUTY_CYCLE = 0.5
const PASS_INTERVAL_MS = 90_000

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type SessionSearchServiceState = 'starting' | 'ready' | 'restarting' | 'failed' | 'disabled'

function resolveServicePaths(): { entry: string; modelDir: string } {
  const app = hasAppEnvironment() ? getAppEnvironment() : null
  const appPath = app?.getAppPath() ?? process.cwd()
  const packaged = app?.isPackaged() ?? false
  if (packaged) {
    const unpacked = appPath.replace('app.asar', 'app.asar.unpacked')
    return {
      entry: join(unpacked, 'out', 'main', ENTRY_NAME),
      modelDir: join(unpacked, 'resources', 'session-search')
    }
  }
  const adjacent = join(appPath, ENTRY_NAME)
  const models = [
    join(appPath, 'resources', 'session-search'),
    resolve(appPath, '..', '..', 'resources', 'session-search'),
    join(process.cwd(), 'resources', 'session-search')
  ]
  return {
    entry: existsSync(adjacent) ? adjacent : join(appPath, 'out', 'main', ENTRY_NAME),
    modelDir: models.find((dir) => existsSync(dir)) ?? models[0]!
  }
}

export class SessionSearchService {
  private child: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failures: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private stopped = false
  state: SessionSearchServiceState = 'starting'

  constructor(private readonly userDataPath: string) {}

  start(): void {
    if (this.stopped || this.child) {
      return
    }
    const { entry, modelDir } = resolveServicePaths()
    if (!existsSync(entry)) {
      this.state = 'failed'
      console.error('[session-search] service entry not found:', entry)
      return
    }
    const child = spawnProcess({
      program: process.execPath,
      args: ['--max-old-space-size=512', entry],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: buildAiVaultServiceEnv()
    })
    lowerAiVaultServicePriority(child.pid)
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => console.error(String(chunk).trimEnd()))
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error('session search service start timed out')),
        READY_TIMEOUT_MS
      )
      child.on('message', (message: unknown) => {
        if (!isSessionSearchChildMessage(message)) {
          return
        }
        if (message.type === 'ready') {
          clearTimeout(timer)
          this.state = 'ready'
          resolveReady()
          return
        }
        const call = this.pending.get(message.id)
        if (!call) {
          return
        }
        this.pending.delete(message.id)
        clearTimeout(call.timer)
        if (message.type === 'result') {
          call.resolve(message.value)
        } else {
          call.reject(new Error(message.message))
        }
      })
    })
    this.ready.catch(() => undefined)
    child.on('exit', () => this.onExit(child))
    child.send({
      type: 'init',
      protocol: SESSION_SEARCH_SERVICE_PROTOCOL,
      dbPath: join(this.userDataPath, 'session-search', 'index-v1.sqlite'),
      modelDir,
      homeDir: homedir(),
      appDataDirs: [this.userDataPath],
      hostLabel: localHostLabel(),
      dutyCycle: DUTY_CYCLE,
      passIntervalMs: PASS_INTERVAL_MS
    })
  }

  private onExit(child: ChildProcess): void {
    if (this.child !== child) {
      return
    }
    this.child = null
    this.ready = null
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error('session search service stopped'))
      this.pending.delete(id)
    }
    if (this.stopped) {
      return
    }
    const now = Date.now()
    this.failures = [...this.failures.filter((at) => now - at < RESTART_MAX_MS), now]
    if (this.failures.length >= MAX_QUICK_FAILURES) {
      this.state = 'failed'
      console.error('[session-search] service keeps exiting; content search is off until restart')
      return
    }
    this.state = 'restarting'
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.failures.length - 1))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  private async request<T>(
    operation: SessionSearchServiceOperation,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    if (!this.child && this.state === 'starting') {
      // A search before the delayed start begins indexing now rather than failing.
      this.start()
    }
    if (!this.child || !this.ready) {
      throw new Error(`session search is ${this.state}`)
    }
    await this.ready
    const child = this.child
    if (!child) {
      throw new Error('session search service stopped')
    }
    const id = this.nextId++
    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(new Error('session search timed out'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolveCall as (value: unknown) => void,
        reject: rejectCall,
        timer
      })
      child.send({ type: 'request', id, ...operation })
    })
  }

  search(query: string, limit: number): Promise<SessionSearchServiceSearchValue> {
    return this.request({ op: 'search', query, limit })
  }

  status(): Promise<SessionSearchServiceStatus> {
    return this.request({ op: 'status' })
  }

  /** Existing incremental index only; never scans a transcript on behalf of a card. */
  sessionLinks(sessionKey: string): Promise<string[] | null> {
    return this.request({ op: 'sessionLinks', sessionKey })
  }

  summaryCandidates(args: {
    limit: number
    minBytes: number
    activeSinceMs: number
    idleBeforeMs?: number
  }): Promise<SessionSearchSummaryCandidate[]> {
    return this.request({ op: 'summaryCandidates', ...args }, 60_000)
  }

  saveModelSummary(sessionKey: string, summary: string, basisBytes: number): Promise<boolean> {
    return this.request({ op: 'saveModelSummary', sessionKey, summary, basisBytes })
  }

  /** Existing, current model summaries only; never starts generation. */
  summaryTitles(sessionKeys: string[]): Promise<Record<string, string>> {
    return this.request({ op: 'summaryTitles', sessionKeys })
  }

  /** Work sessions active since `sinceMs`, with how each was started (the omnios Work feed). */
  feedRows(args: { sinceMs: number; limit: number }): Promise<SessionSearchFeedRow[]> {
    return this.request({ op: 'feedRows', ...args }, 60_000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
    }
    const child = this.child
    if (child?.connected) {
      child.send({ type: 'shutdown' })
    }
    this.child = null
  }
}

let service: SessionSearchService | null = null

export function getSessionSearchService(): SessionSearchService | null {
  return service
}

/** Start indexing this host's transcripts shortly after launch; returns the stop function. */
export function startSessionSearch(args: Omit<SessionSummaryDeps, 'service'>): () => Promise<void> {
  if (process.env.OMNI_SESSION_SEARCH_DISABLED === '1') {
    return async () => undefined
  }
  const current = new SessionSearchService(args.userDataPath)
  service = current
  const timer = setTimeout(() => current.start(), START_DELAY_MS)
  timer.unref?.()
  const stopSummaries = startSessionSummaries({ ...args, service: getSessionSearchService })
  // Why here: the omnios Work feed is posted from this index, so it lives and stops with it.
  const stopWorkFeed = startWorkFeedPublisher({
    service: getSessionSearchService,
    userDataPath: args.userDataPath,
    host: localHostLabel()
  })
  return async () => {
    clearTimeout(timer)
    stopSummaries()
    stopWorkFeed()
    if (service === current) {
      service = null
    }
    await current.stop()
  }
}
