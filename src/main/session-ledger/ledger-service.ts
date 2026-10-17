import { hostname } from 'node:os'
import type {
  LedgerEventDetail,
  LedgerLocalSession,
  LedgerNowResult,
  LedgerPeersResult
} from '../../shared/session-ledger-contract'
import { agentHookServer } from '../agent-hooks/server'
import { registerPaneKeyTeardownListener } from '../ipc/pty/pane/key-state'
import { flushLedgerPaneStores, sessionLedgerStores } from './ledger-disk-stores'
import { LedgerCommitObserver } from './ledger-commit-observer'
import { LedgerGitEnrichment } from './ledger-git-enrichment'
import { readGitIdentity } from './ledger-git-identity'
import { LedgerRegisterBinding } from './ledger-register-binding'
import { LedgerCardLinks } from './ledger-card-links'
import type { LedgerCardLink, LedgerWorkspaceLinks } from './ledger-card-links'
import { batchEnvelope, hookIdentityPatch, pendingStartEvent } from './ledger-row-events'
import {
  createSessionLedgerClient,
  currentLedgerPrincipal,
  type SessionLedgerClient
} from './ledger-client'
import { LedgerEventQueue, LEDGER_TEARDOWN_BUDGET_MS } from './ledger-event-queue'
import {
  LedgerPaneRegistry,
  setActiveLedgerPaneRegistry,
  type LedgerPaneEntry
} from './ledger-identity'
import {
  isCompletedGitCommit,
  isEndingHook,
  mapHookToLedgerEvents,
  stopReasonForTeardown,
  type LedgerHookObservation,
  type LedgerTeardownCause
} from './ledger-lifecycle'
import { readMutedRepos, setRepoMuted } from './ledger-muted-repos'
import { LedgerLocalSessionListeners } from './ledger-local-session-listeners'
import { LedgerResumeLinks } from './ledger-resume-links'
import { LedgerOwnerLedger, needsOwnRow } from './ledger-row-owner'
import { publishablePath } from './ledger-path-privacy'
import { LedgerWorkLinks } from './ledger-work-links'
import type {
  LedgerHookStatus,
  LedgerPaneSpawn,
  SessionLedgerServiceDeps
} from './ledger-service-deps'

export type { LedgerHookStatus, SessionLedgerServiceDeps } from './ledger-service-deps'

export { LEDGER_QUEUE_FILE_NAME } from './ledger-disk-stores'

/**
 * Wires identity stamping, the hook feed, PTY/tab/quit teardown and the bounded queue
 * into one fire-and-forget ledger client. Nothing here blocks a spawn or a quit.
 */
export class SessionLedgerService {
  // Why one registry for the service's life: a pane stamped before `start()` and the IPC
  // subscription taken before it must both survive the store being attached.
  private readonly registry = new LedgerPaneRegistry()
  /** A finished reply's Slite docs, omnios pages and Claude artifacts: the omnios Work log. */
  readonly workLinks = new LedgerWorkLinks(this.registry, (entry, e) => this.enqueue(entry, e))
  private queue: LedgerEventQueue | null = null
  private readonly client: SessionLedgerClient
  private readonly host: () => string
  private readonly unsubscribes: (() => void)[] = []
  private workspaceRootByPane = new Map<string, string>()
  private started = false
  private readonly cardLinks: LedgerCardLinks
  private readonly registers: LedgerRegisterBinding
  private readonly commits: LedgerCommitObserver
  private readonly git: LedgerGitEnrichment
  private readonly principal: () => string | null
  private readonly owners = new LedgerOwnerLedger()
  private readonly localSessionListeners = new LedgerLocalSessionListeners()
  readonly resumeLinks: LedgerResumeLinks

  constructor(private readonly deps: SessionLedgerServiceDeps = {}) {
    this.client = deps.client ?? createSessionLedgerClient()
    this.host = deps.host ?? (() => hostname())
    const principal = deps.principal ?? currentLedgerPrincipal
    let last: string | null = null
    // Why: every read of the principal is also an observation — a later claim depends on who
    // was seen — and a change re-publishes the local rows, which are that person's alone.
    this.principal = () => {
      const current = this.owners.observe(principal())
      if (current !== last) {
        last = current
        this.localSessionListeners.notify(this.registry.localSessions(current))
      }
      return current
    }
    this.registers = new LedgerRegisterBinding(
      this.client,
      this.principal,
      (ledgerId, account) => this.owners.claim(this.registry, ledgerId, account),
      deps.warn
    )
    this.cardLinks = new LedgerCardLinks(
      (entry, body) => this.registers.send(entry, body),
      deps.linkedCard ?? null
    )
    this.resumeLinks = new LedgerResumeLinks(
      this.registry,
      this.owners,
      this.cardLinks,
      this.principal
    )
    this.commits = new LedgerCommitObserver(deps.readGit)
    this.git = new LedgerGitEnrichment(
      this.registry,
      this.registers,
      this.commits,
      deps.resolveGitIdentity ?? readGitIdentity,
      (entry, event) => this.enqueue(entry, event)
    )
    setActiveLedgerPaneRegistry(this.registry)
    this.registry.subscribe(() => this.localSessionListeners.notify(this.localSessions()))
  }

  /**
   * The store that holds each workspace's explicit card link, and the runtime's existing
   * `worktreesChanged` fan-out so a link added while a pane is live reaches its row.
   */
  attachWorkspaceLinks(links: LedgerWorkspaceLinks): void {
    this.unsubscribes.push(
      this.cardLinks.attach(links, this.registry, () => void this.registers.retry())
    )
  }

  start(options: { userDataPath: string }): void {
    if (this.started) {
      return
    }
    this.started = true
    const { paneStore, spillStore } = sessionLedgerStores(options.userDataPath, this.deps)
    if (paneStore) {
      this.registry.attachStore(paneStore)
    }
    this.queue = new LedgerEventQueue({
      send: (batch, account) => this.client.events(batch, account),
      principal: this.principal,
      claimOwner: (envelope, account) =>
        this.owners.claim(this.registry, envelope.ledger_id, account),
      rowKnown: (envelope) => this.owners.rowKnown(this.registry, envelope.ledger_id),
      spill: spillStore,
      warn: this.deps.warn
    })
    const subscribeHooks =
      this.deps.subscribeHookStatus ??
      ((listener) => agentHookServer.subscribeEnrichedStatus((payload) => listener(payload)))
    const subscribeTeardown = this.deps.subscribePaneTeardown ?? registerPaneKeyTeardownListener
    this.unsubscribes.push(
      subscribeHooks((status) => this.onHookStatus(status)),
      // Why: the teardown feed says only that the pane's PTY binding is gone. Local pane →
      // its process exited; remote pane → contact was lost or it was closed here, which is
      // never evidence of death (ssh-execution-boundary) — so `close`, never `exit`.
      subscribeTeardown((paneKey) =>
        this.onPaneTeardown(
          paneKey,
          this.registry.get(paneKey)?.remote === false ? 'pty-exit' : 'remote-lost'
        )
      )
    )
    // Why: last run's undelivered start/stop events; delivery failures re-spill, never throw.
    void this.queue.drainSpill()
  }

  /** Env the spawned CLI inherits; stamps the pane (or re-stamps it as a new attempt). */
  stampPaneEnv(spawn: LedgerPaneSpawn): Record<string, string> {
    const previous = this.registry.get(spawn.paneKey)
    const owner = this.principal()
    if (previous?.account === null && owner) {
      // Why: a row this run opened while signed out may be this person's (sole principal seen
      // since); settle that before deciding whether the spawn resumes it or opens its own row.
      this.owners.claim(this.registry, previous.ledgerId, owner)
    }
    if (previous && owner && needsOwnRow(previous, owner, spawn.ptyId ?? null)) {
      // Why: a spawn by a different signed-in person — or into a row that never had an owner —
      // is their own session, not a resume: the earlier row keeps its (absent) owner, is
      // closed, and its held batches never travel under the new person.
      this.onPaneTeardown(spawn.paneKey, 'pty-exit')
      this.registry.remove(spawn.paneKey)
      this.owners.forget(spawn.paneKey, previous.ledgerId)
    }
    const { entry, env } = this.registry.stamp(spawn.paneKey, {
      ptyId: spawn.ptyId,
      cwd: spawn.cwd,
      worktreeId: spawn.worktreeId
    })
    if (!previous || previous !== entry) {
      this.owners.stamped(entry.paneKey)
    }
    if (owner && entry.account === null) {
      // Why: the owner is fixed at spawn whenever it is known (contract §0b.11) — through the
      // same rule as every late claim, so a re-stamp of one spawn that straddles a change of
      // person binds nobody.
      this.owners.claim(this.registry, entry.ledgerId, owner)
    }
    if (spawn.launchAgent) {
      this.registry.update(spawn.paneKey, { agent: spawn.launchAgent })
    }
    this.cardLinks.refresh(this.registry, entry.paneKey, false)
    if (spawn.cwd) {
      this.workspaceRootByPane.set(spawn.paneKey, spawn.cwd)
      void this.git.resolveRepo(entry.paneKey, spawn.cwd)
      void this.commits.prime(entry.paneKey, spawn.cwd).catch(() => {})
    }
    return env
  }

  /** The signed-in person's live rows; another account's rows are not theirs to see. */
  localSessions(): LedgerLocalSession[] {
    return this.registry.localSessions(this.principal())
  }

  subscribeLocalSessions(listener: (rows: LedgerLocalSession[]) => void): () => void {
    return this.localSessionListeners.add(listener)
  }

  now(scope: 'live' | 'today'): Promise<LedgerNowResult> {
    return this.client.now(scope)
  }

  peers(ledgerId: string): Promise<LedgerPeersResult> {
    return this.client.peers(ledgerId)
  }

  async setWaiting(ledgerId: string, waiting: boolean): Promise<void> {
    const row = this.localSessions().find((session) => session.ledgerId === ledgerId)
    const entry = row ? this.registry.get(row.paneId) : undefined
    if (entry) {
      await this.registers.send(entry, { waiting })
      await this.registers.retry()
    }
  }

  /**
   * A person put this conversation in a task. The estate's one session ledger is this row,
   * so the link is recorded here whether or not the hub has a session of its own for the pane
   * — hub person ingest keeps no ledger copy. Answers false for a pane with no row; never throws.
   */
  async linkCard(paneId: string, card: LedgerCardLink): Promise<boolean> {
    const account = this.principal()
    const linked = await this.cardLinks.linkPerson(this.registry, paneId, card, account)
    if (linked) {
      await this.registers.retry()
    }
    return linked && this.principal() === account
  }

  mutedRepos(): string[] {
    return this.deps.mutedRepos?.read() ?? readMutedRepos()
  }

  muteRepo(repo: string, muted: boolean): void {
    ;(this.deps.mutedRepos?.set ?? setRepoMuted)(repo, muted)
  }

  /** A closed tab ends every session it held. */
  onTabClosed(tabId: string): void {
    for (const entry of this.registry.panesForTab(tabId)) {
      this.onPaneTeardown(entry.paneKey, 'tab-close')
      this.registry.remove(entry.paneKey)
      this.workspaceRootByPane.delete(entry.paneKey)
      this.commits.forget(entry.paneKey)
      this.owners.forget(entry.paneKey, entry.ledgerId)
    }
  }

  /** Quit: stop{quit} for every live row, then at most the teardown budget for delivery. */
  async shutdown(budgetMs = LEDGER_TEARDOWN_BUDGET_MS): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe()
    }
    // Why: every live row ends on quit, whoever is signed in; each stop stays bound to its owner.
    for (const row of this.registry.localSessions()) {
      this.onPaneTeardown(row.paneId, 'quit')
    }
    flushLedgerPaneStores()
    await this.queue?.shutdown(budgetMs)
  }

  private onHookStatus(status: LedgerHookStatus): void {
    if (!this.queue || status.isReplay === true) {
      return
    }
    void this.registers.retry()
    try {
      // Why: hooks after an attempt ended (a `/clear`, an SSH reconnect) open a new attempt;
      // a late stop for the ended one must not.
      const entry = this.registry.ensure(status.paneKey, {
        reopenEnded: !isEndingHook(status.hookEventName)
      })
      // Why: a row first seen through hooks is this run's too; its owner is decided like any other.
      this.owners.stampedIfNew(entry.paneKey)
      const patch = hookIdentityPatch(entry, status)
      if (Object.keys(patch).length > 0) {
        this.registry.update(status.paneKey, patch)
      }
      if (patch.worktreeId) {
        this.cardLinks.refresh(this.registry, status.paneKey, entry.started)
      }
      if (status.providerSessionOnly === true || entry.ended) {
        return
      }
      this.emitPendingStart(entry)
      const publishPath = (rawPath: string): string =>
        publishablePath(rawPath, this.workspaceRootByPane.get(status.paneKey) ?? entry.cwd)
      const observation: LedgerHookObservation = {
        hookEventName: status.hookEventName,
        toolName: status.payload.toolName,
        toolInput: status.payload.toolInput,
        toolAgentType: status.toolAgentType
      }
      for (const event of mapHookToLedgerEvents(observation, { publishPath })) {
        this.enqueue(entry, event)
        if (event.kind === 'stop' && event.detail.reason === 'exit') {
          this.registry.update(entry.paneKey, { ended: true })
        }
      }
      if (entry.cwd && isCompletedGitCommit(observation)) {
        void this.git.observeCommit(entry.paneKey, entry.cwd)
      }
    } catch (error) {
      this.deps.warn?.(
        `hook mapping failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private onPaneTeardown(paneKey: string, cause: LedgerTeardownCause): void {
    const entry = this.registry.get(paneKey)
    if (!entry || !entry.started || entry.ended) {
      return
    }
    this.enqueue(entry, { kind: 'stop', detail: { reason: stopReasonForTeardown(cause) } })
    // Why: the pane survives a PTY exit (a resume re-stamps it); its row is ended until then.
    this.registry.update(paneKey, { ended: true, ptyId: null })
  }

  private emitPendingStart(entry: LedgerPaneEntry): void {
    const event = pendingStartEvent(entry)
    if (!event) {
      return
    }
    // Why: an ownerless row takes an owner at its start only through the same claim rule as
    // everywhere else — never whoever happens to be signed in at the first hook.
    const principal = this.principal()
    if (entry.account === null && principal) {
      this.owners.claim(this.registry, entry.ledgerId, principal)
    }
    this.registry.update(entry.paneKey, { pendingStart: null, started: true, ended: false })
    this.enqueue(entry, event)
  }

  /** Every event of a row is queued under the row's owner, not whoever is signed in now. */
  private enqueue(entry: LedgerPaneEntry, event: LedgerEventDetail): void {
    this.queue?.enqueue(batchEnvelope(entry, this.host()), event, entry.account)
  }
}

export const sessionLedgerService = new SessionLedgerService()
