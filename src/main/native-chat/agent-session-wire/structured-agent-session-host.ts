import { readStructuredAgentSessionProcessState } from './structured-agent-session-process-state'
import {
  createHostSessionStatusFeed,
  type StructuredAgentSessionStatusFeed
} from './structured-agent-session-status-feed'
import {
  createStructuredAgentSessionHostReconciler,
  reconcileStructuredAgentSessionRestart,
  createStructuredAgentSessionHostRestore,
  observeStructuredAgentSessionSubscribe
} from './structured-agent-session-host-restore'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'
// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session.

import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionAttachResult,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionHandoffStatus,
  AgentSessionMutationResult,
  AgentSessionOptionsResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { requireAttachedStructuredSession } from './structured-agent-session-lookup'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import {
  createStructuredAgentSessionHostHandoff,
  refreshRecoverableStructuredHandoffStatus,
  type StructuredAgentSessionHostHandoff
} from './structured-agent-session-host-handoff'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { attachStructuredAgentSessionForCaller } from './structured-agent-session-attach-orchestration'
import {
  createStructuredAgentSessionHolds,
  evictHeldStructuredAgentSession,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHolds,
  StructuredAgentSessionHoldOptions
} from './structured-agent-session-holds'
import { resumeStructuredAgentSessionForHold } from './structured-agent-session-hold-resume'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { listStructuredAgentSessionTabs } from './structured-agent-session-host-tabs'
import {
  readStructuredAgentSessionTurnState,
  withOwnerTurnState
} from './structured-agent-session-host-turn-state'
import {
  cancelStructuredAgentSessionTurn,
  readStructuredAgentSessionOptions,
  respondToStructuredAgentSessionPrompt,
  setStructuredAgentSessionOption,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import {
  closeNativeStructuredAgentSessions,
  flushStructuredSessionHost
} from './structured-agent-session-host-teardown'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'
import { buildStructuredAgentSessionAttachContext } from './structured-agent-session-host-attach-context'
import { createStructuredSessionOutcomeAccess } from './structured-agent-session-outcome-authority'
import type { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
export class StructuredAgentSessionHost {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  private readonly sessions = new Map<string, StructuredAgentSessionHostSession>()
  private readonly subscribers = new AgentSessionSubscribers((sessionId, journal) =>
    this.statusFeed.publish(sessionId, journal)
  )
  private readonly statusFeed: StructuredAgentSessionStatusFeed
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  private readonly handoffs: StructuredAgentSessionHostHandoff
  private readonly restore: ReturnType<typeof createStructuredAgentSessionHostRestore>
  private readonly holds: StructuredAgentSessionHolds
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: StructuredAgentSessionBackgroundTaskChannel

  constructor(readonly deps: StructuredAgentSessionHostDeps) {
    this.statusFeed = createHostSessionStatusFeed(deps, this.sessions)
    this.backgroundTasks = new StructuredAgentSessionBackgroundTaskChannel(
      deps,
      this.sessions,
      this.subscribers,
      (sessionId) => this.requireSession(sessionId),
      (sessionId) => this.handoffs.status(sessionId)
    )
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(
      deps,
      (record) => this.restoreRenewedHandoff(record.sessionId),
      (record, probe) =>
        this.sessions.has(record.sessionId)
          ? this.serialize(record.sessionId, () =>
              this.handoffs.recoverDeadTuiOwner(record.sessionId, record.lease.runtimeFence, probe)
            )
          : Promise.resolve(),
      (sessionId, error) => this.eventRecovery.recoverAfterSinkFailure(sessionId, error)
    )
    this.reconcileLeases = createStructuredAgentSessionHostReconciler(deps, {
      probeRecord: (record) => this.runtimeState.probeRecord(record),
      now: () => this.now()
    })
    this.handoffs = createStructuredAgentSessionHostHandoff(deps, {
      session: (sessionId) => this.requireSession(sessionId),
      findSession: (sessionId) => this.sessions.get(sessionId),
      eventSink: (sessionId) => this.runtimeState.eventSinkFor(sessionId),
      flush: (sessionId) => this.flushStreamedEvents(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      subscribers: this.subscribers,
      now: this.now
    })
    this.holds = createStructuredAgentSessionHolds(this.lifetimeContext(), {
      resume: (sessionId) => this.resumeForHold(sessionId),
      evict: (sessionId) => this.close(sessionId)
    })
    const restore = createStructuredAgentSessionHostRestore(deps, {
      reconcileLeases: this.reconcileLeases,
      sessions: this.sessions,
      subscribers: this.subscribers,
      runtimeState: this.runtimeState,
      holds: this.holds,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      attachContext: () => this.attachContext(),
      restoreHandoff: (sessionId) => this.handoffs.restore(sessionId),
      now: () => this.now()
    })
    this.restore = restore
    this.eventRecovery = restore.eventRecovery
    this.runtimeState.startLeaseRenewal()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  processState = (sessionId: string) =>
    readStructuredAgentSessionProcessState(this.lifetimeContext(), sessionId)

  pendingPrompts = (sessionId: string) => this.backgroundTasks.pendingPrompts(sessionId)

  subscribeStatus = (subscriber: Parameters<StructuredAgentSessionStatusFeed['subscribe']>[0]) =>
    this.statusFeed.subscribe(subscriber)
  liveSessionStatusSummaries = () => this.statusFeed.liveSessionSummaries()

  turnState = (sessionId: string) => readStructuredAgentSessionTurnState(this.sessions, sessionId)
  isHeld = (sessionId: string): boolean => this.holds.isHeld(sessionId)

  readonly outcomeSource = createStructuredSessionOutcomeAccess(() => ({
    sessions: this.sessions,
    store: this.deps.store,
    adapter: this.deps.adapter,
    now: this.now()
  }))
  /** A surface bound to this session and wants it live. The FIRST hold on a session with no
   *  provider child is what resumes one; a retained hold (a subscription) only keeps it. */
  hold = (
    sessionId: string,
    holderId: string,
    options?: StructuredAgentSessionHoldOptions
  ): Promise<void> => this.holds.hold(sessionId, holderId, options)

  /** That surface is gone. The child outlives it by the release grace, and by any running turn. */
  release = (sessionId: string, holderId: string): void => this.holds.release(sessionId, holderId)

  private async resumeForHold(sessionId: string): Promise<void> {
    await resumeStructuredAgentSessionForHold({
      sessionId,
      deps: this.deps,
      now: () => this.now(),
      reconcileLeases: (id) => this.reconcileLeases(id),
      resolveRecovery: (id) => this.runtimeState.resolveRecovery(id),
      attach: (params) => this.attach({ callerKey: 'trusted-local:surface-hold' }, params)
    })
  }

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

  private lifetimeContext(): StructuredAgentSessionLifetimeContext {
    return {
      deps: this.deps,
      subscribers: this.subscribers,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now()
    }
  }

  /** The host's half of attaching, named so it cannot grow dependencies unnoticed. */
  private attachContext(): StructuredAgentSessionAttachContext {
    return buildStructuredAgentSessionAttachContext({
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    })
  }
  /** Releases a session's resources without ending the conversation: the record and journal stay
   *  on disk, so the same session can be attached again. */
  close(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      await this.handoffs.closeRetainedTuiOwner(sessionId)
      await evictHeldStructuredAgentSession(this.lifetimeContext(), sessionId)
      // Whoever asked for the close, the surfaces that were holding this session are looking at a
      // session that no longer exists. A failed eviction throws above and keeps them.
      this.holds.forget(sessionId)
    })
  }

  closeNativeSessions(): Promise<void> {
    return closeNativeStructuredAgentSessions(this.sessions, (id) => this.close(id))
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  listSessionTabs = () => listStructuredAgentSessionTabs(this.sessions)

  getPersistedVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    this.deps.store.getVisibleSessionTabIndex()

  setSessionTabVisibility = (sessionId: string, visible: boolean): Promise<void> =>
    this.deps.store.setSessionTabVisibility(sessionId, visible)

  reconcileRestartLeases = () => reconcileStructuredAgentSessionRestart(this.reconcileLeases)

  restoreReadableSessions = (sessionIds?: readonly string[]): Promise<void> =>
    this.restore.restoreReadableSessions(sessionIds)

  /** Make one persisted session addressable again; see `structured-agent-session-reveal`. */
  revealSession = (sessionId: string): Promise<StructuredAgentSessionReveal> =>
    this.restore.revealSession(sessionId)

  private serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> =>
    this.tasks.serialize(sessionId, task)

  private restoreRenewedHandoff(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      if (this.sessions.has(sessionId)) {
        await refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
      }
    })
  }

  attach(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams
  ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
    return attachStructuredAgentSessionForCaller(this.attachContext(), caller, params)
  }

  flushStreamedEvents = (sessionId: string): Promise<void> =>
    this.runtimeState.flushEventSink(sessionId)

  flushAllStreamedEvents = (): Promise<void> =>
    flushStructuredSessionHost({
      holds: this.holds,
      runtimeState: this.runtimeState,
      handoffs: this.handoffs,
      tasks: this.tasks,
      sessions: this.sessions
    })

  private mutationContext(): StructuredAgentSessionMutationContext {
    return {
      deps: this.deps,
      sessions: this.sessions,
      publish: (sessionId, journal) => this.subscribers.publish(sessionId, journal),
      requireSession: (sessionId) => this.requireSession(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    }
  }

  send = (...args: Parameters<StructuredConversationCommandController['send']>) =>
    this.conversationCommands.send(...args)

  cancel = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof cancelStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof cancelStructuredAgentSessionTurn> =>
    cancelStructuredAgentSessionTurn(this.mutationContext(), caller, params)

  respondToPrompt = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof respondToStructuredAgentSessionPrompt>[2]
  ): ReturnType<typeof respondToStructuredAgentSessionPrompt> =>
    respondToStructuredAgentSessionPrompt(this.mutationContext(), caller, params)

  setOption = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof setStructuredAgentSessionOption>[2]
  ): ReturnType<typeof setStructuredAgentSessionOption> =>
    setStructuredAgentSessionOption(this.mutationContext(), caller, params)

  readOptions = (sessionId: string): Promise<AgentSessionOptionsResult> =>
    readStructuredAgentSessionOptions(this.mutationContext(), sessionId)

  conversationCommand = (...args: Parameters<StructuredConversationCommandController['run']>) =>
    this.conversationCommands.run(...args)
  conversationReplacements = () => this.conversationCommands.replacements()

  async handoffStatus(sessionId: string): Promise<AgentSessionHandoffStatus> {
    this.requireSession(sessionId)
    return this.serialize(sessionId, () =>
      refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
    )
  }

  history = (request: AgentSessionHistoryRequest): AgentSessionHistoryResult =>
    withOwnerTurnState(this.backgroundTasks.history(request), this.turnState(request.sessionId))

  subscribe(input: AgentSessionSubscribeInput): () => void {
    const session = this.requireSession(input.sessionId)
    observeStructuredAgentSessionSubscribe(session, () => this.attachContext(), input.sessionId)
    return this.backgroundTasks.subscribe(input)
  }

  publishBackgroundTaskState: StructuredAgentSessionBackgroundTaskChannel['publish'] = (
    sessionId,
    state
  ) => this.backgroundTasks.publish(sessionId, state)
  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  private requireSession = (sessionId: string) =>
    requireAttachedStructuredSession(this.sessions, sessionId)
}
