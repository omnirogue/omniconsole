import type { AgentTemplateSettings } from '../../shared/agent-templates'
import {
  SESSION_PREP_BIG_BATCH,
  SESSION_PREP_CONCURRENCY,
  SESSION_PREP_MAX_ITEMS,
  type SessionPrepBatchView,
  type SessionPrepReuseChoice,
  type SessionPrepSteps
} from '../../shared/session-prep-types'
import {
  sessionPrepAgentTemplateChoices,
  sessionPrepAgentTemplate
} from './session-prep-agent-template'
import type { SessionPrepHost } from './session-prep-host'
import { createSessionPrepBatchId } from './session-prep-ids'
import { processSessionPrepItem } from './session-prep-item-pipeline'
import { foldOrderedItems } from './session-prep-order'
import { assertSessionPrepExecutionHost, sessionPrepHostId } from './session-prep-execution-host'
import { withStatedHost } from './session-prep-stated-host'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import type { SessionPrepReuse } from './session-prep-reuse'
import { applySessionPrepReuseChoice } from './session-prep-reuse-choice'
import {
  SESSION_PREP_LIST_RECENT_MS,
  SESSION_PREP_TERMINAL_BATCH,
  SESSION_PREP_TERMINAL_ITEM,
  toSessionPrepBatchView,
  type SessionPrepBatchRecord,
  type SessionPrepItemRecord
} from './session-prep-records'
import { resumeSessionPrepBatch } from './session-prep-resume'
import type { SessionPrepStore } from './session-prep-store'
import {
  SessionPrepRequests,
  type RequestParams,
  type SessionPrepCheckedRequest,
  type ConnectorRegistration
} from './session-prep-requests'
import { sessionPrepConnectorResult } from './session-prep-connector-result'
import { planSessionPrepConnector } from './session-prep-connector-plan'
import type { SessionPrepServiceOptions } from './session-prep-service-options'
import { WorkflowScriptSlots } from '../runtime/workflow-script/workflow-script-slots'

export class SessionPrepService {
  private readonly host: SessionPrepHost
  private readonly steps: () => SessionPrepSteps
  private readonly store: SessionPrepStore
  private readonly now: () => number
  private readonly newId: () => string
  private readonly reuse: SessionPrepReuse | undefined
  private readonly agentTemplates: () => AgentTemplateSettings | undefined
  private readonly pumps = new Map<string, Promise<void>>()
  private readonly inflight = new Map<string, Set<number>>()
  private readonly preparationSlots = new WorkflowScriptSlots(SESSION_PREP_CONCURRENCY)
  private readonly requests: SessionPrepRequests

  constructor(args: SessionPrepServiceOptions) {
    this.host = args.host
    this.steps = args.steps
    this.store = args.store
    this.now = args.now ?? Date.now
    this.newId = args.newId ?? (() => createSessionPrepBatchId(this.now()))
    this.reuse = args.reuse
    this.agentTemplates = args.agentTemplates ?? (() => undefined)
    this.requests = new SessionPrepRequests(this.store, this.now, this.newId, (batchId) =>
      this.schedule(batchId, () => this.planBatch(batchId))
    )
  }

  async start(): Promise<void> {
    try {
      await this.store.load()
    } catch {
      return
    }
    for (const batch of this.store.list()) {
      // Why per batch: one batch whose workspace vanished while the app was closed must not stop
      // the others resuming, nor throw out of startup on every launch.
      try {
        const action = await resumeSessionPrepBatch(this.launchCtx(), batch)
        if (action === 'plan') {
          this.schedule(batch.id, () => this.planBatch(batch.id))
        } else if (action === 'pump') {
          this.schedule(batch.id, () => this.pump(batch.id))
        }
      } catch (error) {
        batch.state = 'failed'
        batch.updatedAt = this.now()
        batch.dropped = [...batch.dropped, `Could not resume: ${shortPlanFailure(error)}`]
        await this.store.persist().catch(() => undefined)
      }
    }
  }

  request(params: RequestParams): { batchId: string } {
    return this.requests.request(params)
  }

  /** A terminal's request: checked and saved before it is reported as started. */
  requestFromTerminal(params: RequestParams): Promise<SessionPrepCheckedRequest> {
    return this.requests.requestChecked(params, this.host)
  }

  requestDurable(params: RequestParams): Promise<{ batchId: string }> {
    return this.requests.requestDurable(params)
  }

  async cancel(batchId: string): Promise<SessionPrepBatchView> {
    const batch = this.requireBatch(batchId)
    if (!SESSION_PREP_TERMINAL_BATCH.has(batch.state)) {
      for (const item of batch.items) {
        // Why skip 'launching': the create call cannot be interrupted, so that item will launch.
        if (!SESSION_PREP_TERMINAL_ITEM.has(item.state) && item.state !== 'launching') {
          item.state = 'cancelled'
        }
      }
      const inFlight = batch.items.some((item) => item.state === 'launching')
      batch.state = inFlight
        ? 'running'
        : batch.items.some((item) => item.state === 'launched')
          ? 'done'
          : 'cancelled'
      batch.updatedAt = this.now()
      await this.store.persist()
    }
    return toSessionPrepBatchView(batch)
  }

  async confirm(batchId: string): Promise<SessionPrepBatchView> {
    const batch = this.requireBatch(batchId)
    if (batch.state !== 'awaiting-confirm') {
      throw new Error('This batch is not waiting for confirmation.')
    }
    batch.state = 'running'
    batch.updatedAt = this.now()
    await this.store.persist()
    this.schedule(batch.id, () => this.pump(batch.id))
    return toSessionPrepBatchView(batch)
  }

  /**
   * The person's choice for an item offered to an existing session: give it that session (through
   * `session assign`, which re-checks it is still free), or launch new as if none was offered.
   */
  async decideReuse(
    batchId: string,
    index: number,
    choice: SessionPrepReuseChoice
  ): Promise<SessionPrepBatchView> {
    const batch = this.requireBatch(batchId)
    await applySessionPrepReuseChoice(this.launchCtx(), batch, index, choice, () =>
      this.schedule(batchId, () => this.pump(batchId))
    )
    return toSessionPrepBatchView(batch)
  }

  async requestConnector(params: RequestParams, registration: ConnectorRegistration) {
    const { batchId } = await this.requests.requestDurable(params, registration)
    return sessionPrepConnectorResult(this.requireBatch(batchId))
  }

  get(batchId: string): SessionPrepBatchView {
    return toSessionPrepBatchView(this.requireBatch(batchId))
  }

  listForSource(paneKey: string): SessionPrepBatchView[] {
    const cutoff = this.now() - SESSION_PREP_LIST_RECENT_MS
    return this.store
      .list()
      .filter(
        (batch) =>
          batch.source.paneKey === paneKey &&
          (!SESSION_PREP_TERMINAL_BATCH.has(batch.state) || batch.updatedAt >= cutoff)
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(toSessionPrepBatchView)
  }

  private launchCtx(): SessionPrepLaunchContext {
    return {
      host: this.host,
      steps: this.steps,
      now: this.now,
      persist: () => this.store.persist(),
      isCancelled: (batchId, index) => {
        const item = this.store.get(batchId)?.items.find((entry) => entry.index === index)
        return item?.state === 'cancelled'
      },
      batch: (batchId) => this.requireBatch(batchId),
      agentTemplate: (batch, item) => sessionPrepAgentTemplate(this.agentTemplates(), batch, item),
      ...(this.reuse ? { reuse: this.reuse } : {})
    }
  }

  private schedule(batchId: string, task: () => Promise<void>): void {
    const previous = this.pumps.get(batchId) ?? Promise.resolve()
    const next = previous.then(task).catch((error) => {
      const batch = this.store.get(batchId)
      if (batch && !SESSION_PREP_TERMINAL_BATCH.has(batch.state)) {
        batch.state = 'failed'
        batch.updatedAt = this.now()
        batch.dropped = [...batch.dropped, shortPlanFailure(error)]
        void this.store.persist()
      }
    })
    this.pumps.set(batchId, next)
  }

  private async planBatch(batchId: string): Promise<void> {
    const batch = this.requireBatch(batchId)
    if (batch.state !== 'planning') {
      return
    }
    const source = await this.host.resolveWorktree(batch.source.worktreeId)
    assertSessionPrepExecutionHost(source)
    const planned = await this.preparationSlots.run(async () => {
      if (batch.state !== 'planning') {
        return undefined
      }
      if (batch.connectorLaunch) {
        return planSessionPrepConnector(batch.request, batch.connectorLaunch)
      }
      return this.steps().plan({
        request: batch.request,
        context: batch.context,
        source: batch.source,
        cwd: source.path,
        connectionId: source.connectionId,
        repos: this.host
          .listRepos()
          .map(({ selector, name, host, hostAliases }) => ({ selector, name, host, hostAliases })),
        agentTemplates: sessionPrepAgentTemplateChoices(this.agentTemplates())
      })
    })
    if (!planned || batch.state !== 'planning') {
      return
    }
    const items = foldOrderedItems(
      withStatedHost(planned.items, batch.request, this.host.listRepos(), sessionPrepHostId(source))
    ).slice(0, SESSION_PREP_MAX_ITEMS)
    // Why keep earlier notes: they say where a terminal request started instead.
    batch.dropped = [...batch.dropped, ...planned.dropped]
    batch.items = items.map((item, index) => plannedItem(index, item))
    if (batch.items.length === 0) {
      batch.state = 'failed'
    } else if (batch.items.length > SESSION_PREP_BIG_BATCH) {
      batch.state = 'awaiting-confirm'
    } else {
      batch.state = 'running'
    }
    batch.updatedAt = this.now()
    await this.store.persist()
    if (batch.state === 'running') {
      await this.pump(batchId)
    }
  }

  private async pump(batchId: string): Promise<void> {
    const running = new Map<number, Promise<void>>()
    this.inflight.set(batchId, new Set())
    const ctx = this.launchCtx()
    for (;;) {
      const batch = this.store.get(batchId)
      if (!batch || batch.state !== 'running') {
        return
      }
      const active = this.inflight.get(batchId)!
      const ready = batch.items.filter(
        (item) =>
          item.state === 'planned' && !running.has(item.index) && itemDependenciesMet(batch, item)
      )
      while (running.size < SESSION_PREP_CONCURRENCY && ready.length > 0) {
        const item = ready.shift()!
        active.add(item.index)
        const work = this.preparationSlots
          .run(() => processSessionPrepItem(ctx, batchId, item.index))
          .catch((error) => {
            if (!SESSION_PREP_TERMINAL_ITEM.has(item.state)) {
              item.state = 'failed'
              item.note = shortPlanFailure(error)
            }
          })
          .finally(() => {
            running.delete(item.index)
            active.delete(item.index)
          })
        running.set(item.index, work)
      }
      if (running.size === 0) {
        this.finishIfSettled(batch)
        await this.store.persist()
        return
      }
      await Promise.race(running.values())
    }
  }

  private finishIfSettled(batch: SessionPrepBatchRecord): void {
    if (batch.items.every((item) => SESSION_PREP_TERMINAL_ITEM.has(item.state))) {
      batch.state = 'done'
      batch.updatedAt = this.now()
    }
  }

  private requireBatch(batchId: string): SessionPrepBatchRecord {
    const batch = this.store.get(batchId)
    if (!batch) {
      throw new Error('Session prep batch not found.')
    }
    return batch
  }
}

function plannedItem(
  index: number,
  planned: SessionPrepItemRecord['planned']
): SessionPrepItemRecord {
  return { index, planned, state: 'planned', verdicts: [], repairs: 0 }
}

function itemDependenciesMet(batch: SessionPrepBatchRecord, item: SessionPrepItemRecord): boolean {
  return (item.planned.after ?? []).every((index) => {
    const dependency = batch.items.find((entry) => entry.index === index)
    return !dependency || SESSION_PREP_TERMINAL_ITEM.has(dependency.state)
  })
}

function shortPlanFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
