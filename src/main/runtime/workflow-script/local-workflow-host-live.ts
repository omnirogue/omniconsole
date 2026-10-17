import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowChangedEvent } from '../../../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { localWorkflowChangedEvent } from '../../../shared/local-workflow-changed'
import { WorkflowLiveRegistry } from './workflow-live-registry'
import { createWorkflowViewThrottle, type WorkflowViewThrottle } from './workflow-view-throttle'

/** Pushed views: at most four per second per watcher. */
export const LOCAL_WORKFLOW_WATCH_INTERVAL_MS = 250
/** Window broadcasts: at most one per second per execution. */
export const LOCAL_WORKFLOW_NOTIFY_INTERVAL_MS = 1_000
/** Catches durable writes that no live signal announced (recovery, another host path). */
export const LOCAL_WORKFLOW_DURABLE_PROBE_MS = 1_000

/** States in which nothing moves until the person acts; their notifier is released. */
const SETTLED_STATES = new Set([
  'completed',
  'cancelled',
  'failed',
  'recovery_required',
  'paused',
  'budget_paused'
])

type Notifier = { throttle: WorkflowViewThrottle; last?: string }

/** Owns the live registry, per-subscriber view pushes and the throttled window broadcast. */
export class LocalWorkflowHostLive {
  readonly registry = new WorkflowLiveRegistry()
  private readonly notifiers = new Map<string, Notifier>()

  constructor(
    private readonly options: {
      db: Database.Database
      project: (executionId: string) => LocalWorkflowView
      /** The full view a watcher receives (with the saved-output fields). */
      view: (executionId: string) => Promise<LocalWorkflowView>
      notify?: (event: LocalWorkflowChangedEvent) => void
      /** Durable state kept outside the execution row (working-agent calls), for the probe. */
      durableExtra?: (executionId: string) => string
    }
  ) {
    if (options.notify) {
      // Streamed text never changes what a tab or sidebar row shows; state changes do.
      this.registry.subscribe((executionId, change) => {
        if (change === 'state') {
          this.scheduleNotify(executionId)
        }
      })
    }
  }

  /**
   * Emits the view now and after every durable or live change, at most four times a second. A
   * view identical to the last one sent is skipped, and nothing is sent after the returned stop.
   */
  watch(executionId: string, emit: (view: LocalWorkflowView) => void): () => void {
    let stopped = false
    let last = ''
    const throttle = createWorkflowViewThrottle(async () => {
      const view = await this.options.view(executionId)
      const json = JSON.stringify(view)
      if (!stopped && json !== last) {
        last = json
        emit(view)
      }
    }, LOCAL_WORKFLOW_WATCH_INTERVAL_MS)
    const unsubscribe = this.registry.subscribe((id) => {
      if (id === executionId) {
        throttle.schedule()
      }
    })
    let durable = this.durableKey(executionId)
    const probe = setInterval(() => {
      const next = this.durableKey(executionId)
      if (next !== durable) {
        durable = next
        throttle.schedule()
      }
    }, LOCAL_WORKFLOW_DURABLE_PROBE_MS)
    probe.unref?.()
    throttle.schedule()
    return () => {
      stopped = true
      clearInterval(probe)
      unsubscribe()
      throttle.close()
    }
  }

  private durableKey(executionId: string): string {
    const row = this.options.db
      .prepare('SELECT fence,sequence,state FROM local_workflow_executions WHERE id=?')
      .get(executionId) as { fence: number; sequence: number; state: string } | undefined
    return row
      ? `${row.fence}:${row.sequence}:${row.state}:${this.options.durableExtra?.(executionId) ?? ''}`
      : ''
  }

  private conversationOf(executionId: string): string | undefined {
    const row = this.options.db
      .prepare('SELECT conversation_id FROM local_workflow_executions WHERE id=?')
      .get(executionId) as { conversation_id: string } | undefined
    try {
      // Host conversation keys are [workspaceId, conversationId]; the renderer knows the second.
      const key: unknown = row ? JSON.parse(row.conversation_id) : undefined
      return Array.isArray(key) && typeof key[1] === 'string' ? key[1] : undefined
    } catch {
      return undefined
    }
  }

  private scheduleNotify(executionId: string): void {
    let notifier = this.notifiers.get(executionId)
    if (!notifier) {
      const created: Notifier = {
        throttle: createWorkflowViewThrottle(
          () => this.publish(executionId, created),
          LOCAL_WORKFLOW_NOTIFY_INTERVAL_MS
        )
      }
      notifier = created
      this.notifiers.set(executionId, created)
    }
    notifier.throttle.schedule()
  }

  private publish(executionId: string, notifier: Notifier): void {
    const conversationId = this.conversationOf(executionId)
    if (!conversationId) {
      return
    }
    const event = localWorkflowChangedEvent(this.options.project(executionId), conversationId)
    const key = JSON.stringify(event)
    if (key !== notifier.last) {
      notifier.last = key
      this.options.notify?.(event)
    }
    if (SETTLED_STATES.has(event.state) && this.notifiers.get(executionId) === notifier) {
      // A settled run is quiet; a later Retry or resume creates a fresh notifier.
      notifier.throttle.close()
      this.notifiers.delete(executionId)
    }
  }
}

/**
 * Status for a tab strip or sidebar row. A run left mid-flight by an app restart is not running:
 * opening it recovers the run and pauses it until the person resumes, so it reads as paused.
 */
export function localWorkflowRestingStatus(
  view: LocalWorkflowView,
  conversationId: string,
  unattended: boolean
): LocalWorkflowChangedEvent {
  const event = localWorkflowChangedEvent(view, conversationId)
  if (!unattended || !['running', 'pausing', 'stopping'].includes(event.state)) {
    return event
  }
  return { ...event, state: event.state === 'stopping' ? 'cancelled' : 'paused', running: 0 }
}
