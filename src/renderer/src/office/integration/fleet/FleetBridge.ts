import type { ActionLogEntry } from '../store/coreStore'
import { useCoreStore } from '../store/coreStore'
import { useUiStore } from '../store/uiStore'
import { useTeamStore, getActiveAgentSet } from '../store/teamStore'
import { getAllAgents, fleetAgentIndex, DEFAULT_AGENTIC_SET_ID } from '../../data/agents'
import { useFleetStore } from './fleetStore'
import { apiFetch } from '../../lib/apiBase'
import { refreshJobs } from './jobsApi'
import type {
  DispatchResponse,
  FleetSession,
  HealthEvent,
  HealthResponse,
  SessionsResponse,
  UsageResponse
} from './fleetTypes'

import { FleetSessionProjection } from './FleetSessionProjection'
import { mapStatus } from './fleetSessionPresentation'

export { mapStatus } from './fleetSessionPresentation'

const POLL_MS = 5000
const LOG_CAP = 250
// Per-request ceiling. The hub-proxied feeds can answer in ~6s; anything past
// this is treated as slow/offline so the panel shows an honest marker fast.
const REQ_TIMEOUT_MS = 8000

/**
 * FleetBridge — the seam that replaces the-delegation's Gemini driver.
 *
 * READ-ONLY over our own BFF (GET-only, same-origin, behind the loopback P0
 * floor). Every ~5s it polls /api/sessions, /api/dispatch, /api/health and
 * /api/usage and projects the result into the SAME stores the 3D sim + Kanban +
 * action log + project-info panel already render from:
 *   • sessions → coreStore.tasks (Kanban columns) + character work animations
 *   • agent-type work state → uiStore.agentStatuses (3D)
 *   • session/health/dispatch events → coreStore.actionLog (Activity stream)
 *   • usage/dispatch/health snapshots → fleetStore (provider-usage panel)
 * Nothing is fabricated — unknown values are shown as honest markers.
 */
/**
 * Telemetry-only mode.
 *
 * Vendored into the IDE the office seats this app's WORKSPACES, so the workspace
 * bridge owns the characters, the board and the team. This poller still supplies
 * what only the backoffice knows — provider usage, dispatch load, reliability —
 * and in that mode it must not touch the stores the workspace bridge writes, or
 * the two would fight over every character on screen.
 */
export type FleetBridgeMode = 'full' | 'telemetry'

export class FleetBridge {
  private timer: number | null = null
  private disposed = false
  private sessionProjection = new FleetSessionProjection()
  private seenHealthIds = new Set<string>()
  private lastDispatchSig = ''
  private started = false
  private readonly mode: FleetBridgeMode

  public constructor(mode: FleetBridgeMode = 'full') {
    this.mode = mode
  }

  public start(): void {
    if (this.started) {
      return
    }
    this.started = true

    if (this.mode === 'full') {
      // Force the fleet team so a stale persisted selection can't show a demo team.
      if (useTeamStore.getState().selectedAgentSetId !== DEFAULT_AGENTIC_SET_ID) {
        useTeamStore.setState({ selectedAgentSetId: DEFAULT_AGENTIC_SET_ID })
      }
      const fleet = getActiveAgentSet()
      useUiStore.getState().setInstanceCount(getAllAgents(fleet).length + 1)
      // Keep the board "live" so the Project-Info badge reads working, not idle.
      useCoreStore.setState({ phase: 'working' })
    }

    void this.pollOnce()
    this.timer = window.setInterval(() => void this.pollOnce(), POLL_MS)
  }

  public dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      window.clearInterval(this.timer)
    }
    this.timer = null
  }

  // ── polling ────────────────────────────────────────────────────────────────

  private async getJson<T>(path: string, timeoutMs = REQ_TIMEOUT_MS): Promise<T | null> {
    // Short per-request timeout so a slow/dead hub degrades to an honest marker
    // fast, instead of leaving a panel spinning forever.
    const ctrl = new AbortController()
    const to = window.setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await apiFetch(path, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal
      })
      if (!res.ok) {
        return null
      }
      return (await res.json()) as T
    } catch {
      return null
    } finally {
      window.clearTimeout(to)
    }
  }

  /**
   * One poll cycle. The four feeds are fired concurrently and each writes its
   * own store slice the instant it resolves — the fast, local /api/sessions
   * feed paints the office (3D, Kanban, header counts, logs, brief) on the FIRST
   * pass without waiting on the slow hub-proxied /api/dispatch, /api/health and
   * /api/usage. Those fill their own panels independently as they arrive.
   */
  private async pollOnce(): Promise<void> {
    if (this.disposed) {
      return
    }
    await Promise.allSettled([
      this.pollSessions(),
      this.pollJobs(),
      this.pollDispatch(),
      this.pollHealth(),
      this.pollUsage()
    ])
  }

  // Local + fast: the JOB board (Kanban) is JOB-based now. The 3D characters and
  // the activity log stay driven by sessions (pollSessions, unchanged);
  // refreshJobs folds GET /api/jobs into the jobsStore with honest markers.
  private async pollJobs(): Promise<void> {
    if (this.disposed) {
      return
    }
    await refreshJobs()
  }

  // Local + fast: drives first paint. Never blocked on the hub.
  private async pollSessions(): Promise<void> {
    const sessions = await this.getJson<SessionsResponse>('/api/sessions')
    if (this.disposed) {
      return
    }
    if (!sessions) {
      useFleetStore.getState().set({
        connected: false,
        lastError: 'BFF unreachable (is the loopback service running?)'
      })
      return
    }
    const logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[] = []
    // Sessions become board cards and character states — the workspace bridge's
    // job here, so telemetry mode reads the feed for the panels and stops there.
    if (this.mode === 'full') {
      this.sessionProjection.reconcile(sessions.sessions ?? [], logs)
    }
    useFleetStore.getState().set({
      connected: true,
      lastError: null,
      lastUpdated: Date.now(),
      sessions: sessions.sessions ?? useFleetStore.getState().sessions
    })
    // Brief paints immediately from local data; the hub line lazy-fills below.
    this.updateBrief(sessions.sessions ?? [], useFleetStore.getState().dispatch)
    if (logs.length) {
      this.pushLogs(logs)
    }
  }

  // Hub-proxied + slow: fills the Project-Info dispatch line on its own.
  private async pollDispatch(): Promise<void> {
    const dispatch = await this.getJson<DispatchResponse>('/api/dispatch')
    if (this.disposed) {
      return
    }
    if (!dispatch) {
      if (useFleetStore.getState().dispatchStatus !== 'ready') {
        useFleetStore.getState().set({ dispatchStatus: 'error' })
      }
      return
    }
    const logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[] = []
    this.reconcileDispatch(dispatch, logs)
    useFleetStore.getState().set({ dispatch, dispatchStatus: 'ready', lastUpdated: Date.now() })
    this.updateBrief(useFleetStore.getState().sessions, dispatch)
    if (logs.length) {
      this.pushLogs(logs)
    }
  }

  // Hub-proxied + slow: reliability events → activity log.
  private async pollHealth(): Promise<void> {
    const health = await this.getJson<HealthResponse>('/api/health')
    if (this.disposed || !health) {
      return
    }
    const logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[] = []
    this.reconcileHealth(health, logs)
    useFleetStore.getState().set({ health, lastUpdated: Date.now() })
    if (logs.length) {
      this.pushLogs(logs)
    }
  }

  // Hub-proxied + slow: provider-usage panel.
  private async pollUsage(): Promise<void> {
    const usage = await this.getJson<UsageResponse>('/api/usage')
    if (this.disposed) {
      return
    }
    if (!usage) {
      if (useFleetStore.getState().usageStatus !== 'ready') {
        useFleetStore.getState().set({ usageStatus: 'error' })
      }
      return
    }
    useFleetStore.getState().set({
      usage: usage.accounts ?? useFleetStore.getState().usage,
      usageStatus: 'ready',
      lastUpdated: Date.now()
    })
  }

  // ── health events → activity log ────────────────────────────────────────────

  private reconcileHealth(
    health: HealthResponse,
    logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[]
  ): void {
    const events = health.events ?? []
    for (const ev of events) {
      const key = healthKey(ev)
      if (this.seenHealthIds.has(key)) {
        continue
      }
      this.seenHealthIds.add(key)
      const idx = fleetAgentIndex(ev.machine_id, ev.rule || ev.kind)
      const sev = (ev.severity || 'info').toUpperCase()
      const text = ev.summary || ev.message || ev.detail || ev.kind || 'reliability event'
      logs.push({
        agentIndex: idx,
        action: `[${sev}] ${text}${ev.machine_id ? ` · ${ev.machine_id}` : ''}`
      })
    }
    // bound memory
    if (this.seenHealthIds.size > 500) {
      this.seenHealthIds = new Set(Array.from(this.seenHealthIds).slice(-250))
    }
  }

  // ── dispatch depth changes → activity log ───────────────────────────────────

  private reconcileDispatch(
    dispatch: DispatchResponse,
    logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[]
  ): void {
    const d = dispatch.depth ?? {}
    const cap = dispatch.capacity ?? {}
    const sig = JSON.stringify([
      d.queued,
      d.claimed,
      d.running,
      d.review,
      d.done,
      cap.free_slots,
      cap.in_flight
    ])
    if (sig === this.lastDispatchSig) {
      return
    }
    const first = this.lastDispatchSig === ''
    this.lastDispatchSig = sig
    if (first) {
      return
    } // don't log the very first snapshot as a "change"
    const parts: string[] = []
    if (d.queued != null) {
      parts.push(`${d.queued} queued`)
    }
    if (d.running != null) {
      parts.push(`${d.running} running`)
    }
    if (cap.free_slots != null && cap.in_flight != null) {
      parts.push(`${cap.in_flight} in-flight / ${cap.free_slots} free`)
    }
    logs.push({ agentIndex: 1, action: `Dispatch — ${parts.join(' · ') || 'load changed'}` })
  }

  // ── project brief ────────────────────────────────────────────────────────────

  private updateBrief(sessions: FleetSession[], dispatch: DispatchResponse | null): void {
    const live = sessions.filter((s) => s && !s.personal)
    const machines = new Set(live.map((s) => s.machine_id).filter(Boolean))
    const running = live.filter((s) => mapStatus(s) === 'in_progress').length
    const d = dispatch?.depth ?? {}
    const lines = [
      '**Omni Console — live fleet operations**',
      '',
      `Watching **${live.length}** session${live.length === 1 ? '' : 's'} across **${machines.size}** machine${machines.size === 1 ? '' : 's'} · **${running}** running.`
    ]
    if (dispatch) {
      const disp = dispatch.dispatchers?.length ?? 0
      const run = dispatch.runners?.length ?? 0
      lines.push('')
      lines.push(
        `Dispatch pool: ${disp} dispatcher${disp === 1 ? '' : 's'}, ${run} runner${run === 1 ? '' : 's'}${
          d.queued != null ? ` · ${d.queued} queued` : ''
        }${d.running != null ? ` · ${d.running} running` : ''}.`
      )
      if (dispatch.ok === false && dispatch.reason) {
        lines.push(`\n_Estate: ${dispatch.reason}_`)
      }
    } else {
      // Hub-derived numbers lazy-fill; keep the local brief instant meanwhile.
      const status = useFleetStore.getState().dispatchStatus
      lines.push('')
      lines.push(
        status === 'error' ? '_Dispatch pool: hub slow / offline._' : '_Dispatch pool: loading…_'
      )
    }
    const brief = lines.join('\n')
    if (useCoreStore.getState().userBrief !== brief) {
      useCoreStore.setState({ userBrief: brief })
    }
  }

  // ── log helper ───────────────────────────────────────────────────────────────

  private pushLogs(entries: Omit<ActionLogEntry, 'id' | 'timestamp'>[]): void {
    const ts = Date.now()
    const rows: ActionLogEntry[] = entries.map((e, i) => ({
      ...e,
      id: `fleet_${ts}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: ts + i
    }))
    useCoreStore.setState((s) => ({ actionLog: [...s.actionLog, ...rows].slice(-LOG_CAP) }))
  }
}

function healthKey(ev: HealthEvent): string {
  if (ev.id != null) {
    return `id:${ev.id}`
  }
  return `${ev.source}|${ev.machine_id}|${ev.rule || ev.kind}|${ev.detected_at}|${ev.summary || ev.message}`
}
