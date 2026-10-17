import { AgentHookSpoolPump } from '../shared/agent-hook-spool-pump'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  type HookListenerState
} from '../shared/agent-hook-listener/listener-state'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../shared/agent-hook-listener/endpoint-publication'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference
} from '../shared/agent-hook-transport-interference'
import {
  REMOTE_AGENT_HOOK_ENV,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { drainAgentHookSpool, type SpoolRecord } from '../shared/agent-hook-spool'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import {
  evictCachedPanesOverCap,
  selectReplayableCachedPanes
} from './agent-hook-cached-pane-status'
import { handleAgentHookRequest } from './agent-hook-server-request-handling'
import { ingestAgentHookSpoolRecord } from './agent-hook-server-spool-ingestion'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.omni-relay/agent-hooks`. */
  endpointDir?: string
  /** Env tag forwarded into hook payloads. Defaults to "remote", which main excludes from dev-vs-prod mismatch warnings. */
  env?: string
  /** Fixed auth token. WSL relay passes the host-issued token (already in guest env via WSLENV) so unmodified hook clients authenticate. Defaults to a fresh UUID. */
  token?: string
  /** Preferred bind port. WSL relay passes the Windows listener's port so env-sourced client coords stay truthful; falls back to :0 if occupied. Defaults to :0. */
  preferredPort?: number
  forward: RelayHookForward
  /** Hears each applied report (the session host's owner service tracks turns from them). */
  onApplied?: (event: AgentHookEventPayload) => void
  /**
   * True when the host has been told this pane's tab is gone and no PTY has re-bound the paneKey.
   * Posts from such a pane come from a process the user already closed, so they describe no surface
   * any client owns. Defaults to "never retired", which is the pre-existing behaviour — a listener
   * with no PTY handler behind it (the WSL relay) keeps forwarding everything.
   */
  isPaneSurfaceRetired?: (paneKey: string) => boolean
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
}

export class RelayAgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  private env: string
  private endpointDir: string
  private endpointFilePath: string
  private endpointFileWritten = false
  private state: HookListenerState = createHookListenerState()
  private transportInterference = createHookTransportInterferenceTracker((report) => {
    process.stderr.write(`${describeHookTransportInterference(report)}\n`)
  })
  // Why: retain envelope metadata so replays match live POSTs.
  // Invariant: keys mirror state.lastStatusByPaneKey, populated/cleared in lockstep.
  private lastEnvelopeMetaByPaneKey = new Map<
    string,
    { source: AgentHookSource; env?: string; version?: string }
  >()
  private forward: RelayHookForward
  private isPaneSurfaceRetired: (paneKey: string) => boolean
  private onApplied: ((event: AgentHookEventPayload) => void) | undefined
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private spoolPump: AgentHookSpoolPump | null = null
  private retryScheduler: AgentHookResultRetryScheduler

  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.isPaneSurfaceRetired = options.isPaneSurfaceRetired ?? (() => false)
    this.onApplied = options.onApplied
    this.retryScheduler = new AgentHookResultRetryScheduler({
      state: this.state,
      env: this.env,
      isListening: () => this.server !== null,
      applyEvent: (event, source, env, version) => {
        this.applyEvent(event, source, env, version)
      }
    })
  }

  async start(options: RelayHookServerStartOptions = {}): Promise<void> {
    if (this.server) {
      return
    }
    this.token = this.fixedToken ?? randomUUID()
    this.endpointFileWritten = false
    this.portFallbackApplied = false
    try {
      await drainAgentHookSpool({
        endpointDir: this.endpointDir,
        getPersistedLaunchTokenHash: () => undefined,
        ingest: (record) => this.ingestSpoolRecord(record)
      })
    } catch (err) {
      // Why: a downstream relay failure must not prevent the loopback listener from starting;
      // the untruncated spool file remains available for retry on the next restart.
      process.stderr.write(
        `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
    try {
      await this.listenOn(this.preferredPort)
    } catch (err) {
      // Why: fall back to an ephemeral port on EADDRINUSE; clients use the endpoint file.
      if (this.preferredPort > 0 && (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        this.portFallbackApplied = true
        await this.listenOn(0)
      } else {
        throw err
      }
    }
    const pump = new AgentHookSpoolPump(
      {
        endpointDir: this.endpointDir,
        liveQueueToken: this.token,
        getPersistedLaunchTokenHash: () => undefined,
        ingest: (record) => this.ingestSpoolRecord(record)
      },
      (error) =>
        process.stderr.write(`[relay-hook-server] spool delivery failed: ${String(error)}\n`)
    )
    if (pump.start()) {
      this.spoolPump = pump
    }
    if (options.publishEndpoint !== false) {
      this.publishEndpointFile()
    }
  }

  get usedPortFallback(): boolean {
    return this.portFallbackApplied
  }

  private listenOn(port: number): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    return new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        // Why: clear failed server refs so later start() calls can retry.
        this.server = null
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          process.stderr.write(`[relay-hook-server] server error: ${err.message}\n`)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      }
      this.server!.once('error', onStartupError)
      // Why: loopback only — reachable by the in-box agent CLI (127.0.0.1), not from outside the box.
      this.server!.listen(port, '127.0.0.1', onListening)
    })
  }

  publishEndpointFile(): boolean {
    if (this.port <= 0 || !this.token) {
      this.endpointFileWritten = false
      return false
    }
    this.endpointFileWritten = writeEndpointFile(this.endpointDir, this.endpointFilePath, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT,
      lifecycleQueue: this.spoolPump !== null
    })
    return this.endpointFileWritten
  }

  stop(): void {
    this.spoolPump?.stop()
    this.spoolPump = null
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    this.retryScheduler.clearAll()
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
  }

  /** Request-driven replay: re-forwards each cached paneKey payload as a fresh notification. Forwards are
   *  issued before the request handler returns, so the response trails all replayed notifications. */
  replayCachedPayloadsForPanes(): number {
    const replayable = selectReplayableCachedPanes({
      cachedByPaneKey: this.state.lastStatusByPaneKey,
      metaByPaneKey: this.lastEnvelopeMetaByPaneKey,
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      dropPane: (paneKey) => this.clearPaneState(paneKey)
    })
    for (const { event, meta } of replayable) {
      this.forward(
        buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, { isReplay: true })
      )
    }
    return replayable.length
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane can't resurface as a ghost event on reconnect. */
  clearPaneState(paneKey: string): void {
    this.retryScheduler.clearAssistantMessageRetry(paneKey)
    this.retryScheduler.clearCodexSubagentPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
  }

  /** Env vars to inject into relay-spawned PTYs so the hook script/plugin POSTs back to this loopback server. */
  buildPtyEnv(): Record<string, string> {
    return buildRelayHookPtyEnv({
      port: this.port,
      token: this.token,
      env: this.env,
      endpointFilePath: this.endpointFilePath,
      endpointFileWritten: this.endpointFileWritten
    })
  }

  /** Test-only / diagnostics accessor. */
  getCoordinates(): { port: number; token: string; endpointFilePath: string } {
    return { port: this.port, token: this.token, endpointFilePath: this.endpointFilePath }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deps = {
      token: this.token,
      state: this.state,
      env: this.env,
      transportInterference: this.transportInterference,
      retryScheduler: this.retryScheduler,
      flushSpool: () => this.spoolPump?.flush() ?? Promise.resolve(),
      applyEvent: this.applyEvent.bind(this)
    }
    await handleAgentHookRequest(deps, req, res)
  }

  private applyEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean; rawBody?: unknown } = {}
  ): boolean {
    // Why: this post came from a process still running inside a pane whose tab the user closed.
    // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
    // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
    // transcript the orphan is still writing (#12447). Drop the stale cache with it.
    if (this.isPaneSurfaceRetired(event.paneKey)) {
      this.clearPaneState(event.paneKey)
      return false
    }
    if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
      this.retryScheduler.clearAssistantMessageRetry(event.paneKey)
    }
    // Why: keep PostCompact identity in the replay cache so the client can re-run ownership when
    // it reconnects. Stripping it would let a cold relay replay a completion as an ordinary `done`
    // row and resurrect a pane that the client had already retired.
    const cachedEvent = event
    // Why: delete-then-set makes Map insertion order = recency, so the cap below evicts the longest-idle pane.
    this.state.lastStatusByPaneKey.delete(event.paneKey)
    this.state.lastStatusByPaneKey.set(event.paneKey, cachedEvent)
    this.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
    evictCachedPanesOverCap(this.state.lastStatusByPaneKey, (key) => this.clearPaneState(key))
    this.forward(buildRelayHookEnvelope(event, source, env, version, options))
    this.onApplied?.(event)
    return true
  }

  /** The newest report this relay holds for a pane; null when none. */
  paneStatus(paneKey: string): AgentHookEventPayload | null {
    return this.state.lastStatusByPaneKey.get(paneKey) ?? null
  }

  private ingestSpoolRecord(record: SpoolRecord): Promise<void> {
    const listener = this.server
    return ingestAgentHookSpoolRecord(
      {
        state: this.state,
        env: this.env,
        applyEvent: (event, source, env, version, options) => {
          if (record.isReplay === false && (!listener || this.server !== listener)) {
            throw new Error('hook listener stopped')
          }
          const applied = this.applyEvent(event, source, env, version, options)
          if (applied && source === 'codex' && !event.toolAgentId) {
            this.retryScheduler.clearCodexSubagentPoll(event.paneKey)
          }
          return applied
        }
      },
      record
    )
  }
}
