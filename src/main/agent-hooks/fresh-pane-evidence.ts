import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { ConversationSource } from '../../shared/conversation-source'
import type { ConversationInvalidationReason } from '../runtime/conversation-write-fence'
import type { FreshPaneEvidenceStorage, StoredFreshPane } from './fresh-pane-evidence-store'
import { isBlankFreshStart } from './fresh-session-start'

/**
 * `untouched`: this computer saw the pane's agent start fresh and nothing reach it since (no hook
 * event, typed input or turn). `unknown`: no such record, or a gap in what the hook server saw.
 */
export type FreshPaneReading = 'untouched' | 'touched' | 'unknown'

/** How an untouched record came to be, for the checks its reader still owes it. */
export type FreshPaneStart = {
  startedAt: number
  agentPid: number | null
  agent: string | null
  /** Carried over from an earlier app run: only its own agent process, still alive, vouches for it. */
  restored: boolean
  /** Seeded from a hook row older than the evidence file: nothing typed before then was seen. */
  legacy: boolean
  /** The SSH connection its events arrived on; null for this computer's own panes. */
  connectionId: string | null
  /** The launch identity its start carried (an SSH pane's proof this controller launched it). */
  launchToken: string | null
}

export type FreshPaneEvidenceSources = {
  subscribeHookEvents: (listener: (event: AgentHookEventPayload) => void) => () => void
  subscribeWrites: (
    listener: (
      changed: (source: ConversationSource) => boolean,
      reason: ConversationInvalidationReason
    ) => void
  ) => () => void
  continuityEpoch: () => number
  spooledSince: (paneKey: string, sinceMs: number) => boolean
  now: () => number
  /** A POST the hook server failed to take; absent in memory-only use. */
  subscribeLost?: (listener: () => void) => () => void
  /** An event for the pane reached this run only through the spool drained at its start. */
  drainedSince?: (paneKey: string, sinceMs: number) => boolean
  /** Where records outlive the app run; without it every restart forgets them. */
  store?: FreshPaneEvidenceStorage
  /** The hook server's rows at start: Claude and Codex starts older than the store are seeded. */
  hydratedRows?: () => readonly AgentStatusIpcPayload[]
  /** Changes whenever an SSH transport is lost; absent, SSH events are ignored. */
  connectionEpoch?: (connectionId: string) => number
}

/** SSH records live in memory only, fenced by their connection's epoch. */
type PaneRecord = StoredFreshPane & {
  epoch: number
  restored: boolean
  connectionId?: string
  connectionEpoch?: number
  launchToken?: string | null
}

/** A hydrated row that is still the agent's empty session-start report (Claude or Codex). */
function isLegacyStartRow(row: AgentStatusIpcPayload): boolean {
  return (
    row.connectionId === null &&
    !row.providerSessionOnly &&
    !row.restoredUnconfirmed &&
    row.state === 'done' &&
    row.sessionBoundary === true &&
    !row.prompt &&
    !row.interactivePrompt &&
    !row.lastAssistantMessage &&
    (row.agentType === 'claude' || row.agentType === 'codex')
  )
}

/**
 * Evidence that nobody has asked a pane's agent anything, which a transcript cannot give before
 * Claude writes one on the first prompt. With a store, records survive an app restart: a record
 * from an earlier run reads `untouched` only while no spooled event names the pane since its
 * start, and its reader must still see the same agent process holding the terminal.
 */
export class FreshPaneEvidence {
  private readonly panes = new Map<string, PaneRecord>()
  /** Panes the store holds, so a later touch of one is written too. */
  private readonly persisted = new Set<string>()
  private readonly stops: (() => void)[]

  constructor(private readonly sources: FreshPaneEvidenceSources) {
    this.restore()
    this.stops = [
      sources.subscribeHookEvents((event) => this.observe(event)),
      sources.subscribeWrites((changed, reason) => {
        if (reason !== 'hook') {
          this.touchWhere(changed)
        }
      }),
      sources.subscribeLost?.(() => this.touchWhere(() => true)) ?? (() => {})
    ]
  }

  read(paneKey: string, providerSessionId: string | null): FreshPaneReading {
    const pane = this.panes.get(paneKey)
    if (
      !pane ||
      pane.epoch !== this.sources.continuityEpoch() ||
      (pane.connectionId !== undefined &&
        pane.connectionEpoch !== this.sources.connectionEpoch?.(pane.connectionId))
    ) {
      return 'unknown'
    }
    if (pane.touched) {
      return 'touched'
    }
    if (
      !providerSessionId ||
      pane.providerSessionId !== providerSessionId ||
      this.sources.spooledSince(paneKey, pane.startedAt) ||
      (pane.restored && (this.sources.drainedSince?.(paneKey, pane.startedAt) ?? true))
    ) {
      return 'unknown'
    }
    return 'untouched'
  }

  start(paneKey: string): FreshPaneStart | null {
    const pane = this.panes.get(paneKey)
    return pane
      ? {
          startedAt: pane.startedAt,
          agentPid: pane.agentPid,
          agent: pane.agent,
          restored: pane.restored,
          legacy: pane.legacy === true,
          connectionId: pane.connectionId ?? null,
          launchToken: pane.launchToken ?? null
        }
      : null
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) {
      stop()
    }
    this.panes.clear()
  }

  private restore(): void {
    const stored = this.sources.store?.load()
    if (!stored) {
      return
    }
    const epoch = this.sources.continuityEpoch()
    // Why touched: an event spooled for it while the app was down is something that reached it.
    const drained = (paneKey: string, since: number) =>
      this.sources.drainedSince?.(paneKey, since) ?? true
    let changed = false
    for (const [paneKey, pane] of Object.entries(stored.panes)) {
      const touched = pane.touched || drained(paneKey, pane.startedAt)
      changed ||= touched !== pane.touched
      this.panes.set(paneKey, { ...pane, touched, epoch, restored: true })
      this.persisted.add(paneKey)
    }
    // Why only older than the file: a later start with no record was never watched here.
    for (const row of this.sources.hydratedRows?.() ?? []) {
      if (
        !this.panes.has(row.paneKey) &&
        row.receivedAt < stored.createdAt &&
        isLegacyStartRow(row)
      ) {
        this.panes.set(row.paneKey, {
          epoch,
          startedAt: row.receivedAt,
          providerSessionId: row.providerSession?.id ?? null,
          worktreeId: row.worktreeId ?? null,
          agentPid: row.agentPid ?? null,
          agent: row.agentType ?? null,
          touched: drained(row.paneKey, row.receivedAt),
          legacy: true,
          restored: true
        })
        changed = true
      }
    }
    if (changed) {
      this.persist()
    }
  }

  private observe(event: AgentHookEventPayload): void {
    const remote = event.connectionId
    const connectionEpoch = remote === null ? undefined : this.sources.connectionEpoch?.(remote)
    if (remote !== null && connectionEpoch === undefined) {
      return
    }
    const pane = this.panes.get(event.paneKey)
    const id = event.providerSession?.id ?? null
    const start = isBlankFreshStart(event) && !event.toolAgentId
    if (!pane || (pane.connectionId ?? null) !== remote) {
      // Why only a fresh start opens an untouched record: any other first event may be a person's.
      this.panes.set(event.paneKey, {
        epoch: this.sources.continuityEpoch(),
        startedAt: this.sources.now(),
        providerSessionId: id,
        worktreeId: event.worktreeId ?? null,
        agentPid: event.agentPid ?? null,
        agent: event.source ?? event.payload.agentType ?? null,
        touched: !start || pane !== undefined,
        restored: false,
        ...(remote === null
          ? {}
          : { connectionId: remote, connectionEpoch, launchToken: event.launchToken ?? null })
      })
      if (start && remote === null) {
        this.persist()
      }
      return
    }
    // Why: the same session announcing itself again, or its id arriving late, is not a prompt.
    const quiet =
      start ||
      (event.providerSessionOnly === true && !event.hasExplicitPrompt && !event.payload.prompt)
    if (quiet && (!id || !pane.providerSessionId || id === pane.providerSessionId)) {
      pane.providerSessionId ??= id
      // Why: its hook row is re-stamped by the repeat, and a restart compares the two.
      if (start && !pane.touched) {
        pane.startedAt = this.sources.now()
      }
      if (this.persisted.has(event.paneKey)) {
        this.persist()
      }
      return
    }
    if (!pane.touched) {
      pane.touched = true
      this.persist()
    }
  }

  private touchWhere(changed: (source: ConversationSource) => boolean): void {
    let touched = false
    for (const [paneKey, pane] of this.panes) {
      if (pane.touched) {
        continue
      }
      try {
        pane.touched =
          !pane.worktreeId || changed({ kind: 'pty', paneKey, worktreeId: pane.worktreeId })
      } catch {
        pane.touched = true
      }
      touched ||= pane.touched
    }
    if (touched) {
      this.persist()
    }
  }

  /** Records opened by a fresh start (and their later touches); a pane first seen busy stays in memory. */
  private persist(): void {
    const store = this.sources.store
    if (!store) {
      return
    }
    const panes: Record<string, StoredFreshPane> = {}
    for (const [paneKey, pane] of this.panes) {
      const {
        epoch: _epoch,
        restored: _restored,
        connectionId,
        connectionEpoch: _connectionEpoch,
        launchToken: _launchToken,
        ...stored
      } = pane
      if (connectionId === undefined && (!pane.touched || this.persisted.has(paneKey))) {
        panes[paneKey] = stored
        this.persisted.add(paneKey)
      }
    }
    store.save(panes)
  }
}
