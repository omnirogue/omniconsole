import type { WorkflowLiveObserver, WorkflowLiveUpdate } from './workflow-live-observer'

export const WORKFLOW_LIVE_LOG_LIMIT = 50
export const WORKFLOW_LIVE_TAIL_LIMIT = 2 * 1024
/** Finished executions whose phase, log and seats stay readable; older ones are forgotten. */
export const WORKFLOW_LIVE_FINISHED_LIMIT = 32

export type WorkflowLiveCall = {
  seatId?: string
  phase: 'waiting' | 'starting' | 'running' | 'finishing'
  reason?: 'slot' | 'account'
  attemptId?: string
  startedAt?: number
  activity?: string
  /** Rolling tail of streamed text; provisional and never used for acceptance. */
  tail: string
  outputChars: number
  tokens?: { input: number; output: number }
}

export type WorkflowLiveExecution = {
  phase?: string
  log: string[]
  calls: Map<string, WorkflowLiveCall>
  /** Seat of every call seen this session, kept after the call settles. */
  seats: Map<string, string>
}

/**
 * 'state': something a sidebar or tab would show changed (phase, log, a call moved between
 * waiting/starting/running/finishing or settled). 'output': only streamed text or counters moved.
 */
export type WorkflowLiveChange = 'state' | 'output'
export type WorkflowLiveListener = (executionId: string, change: WorkflowLiveChange) => void

/**
 * In-memory live state per execution. Nothing here is persisted or trusted: the checkpoint store
 * stays the authority, and a call's entry is dropped as soon as durable state takes over.
 */
export class WorkflowLiveRegistry {
  private readonly executions = new Map<string, WorkflowLiveExecution>()
  private readonly listeners = new Set<WorkflowLiveListener>()
  /** Finished execution ids, oldest first. */
  private readonly finished: string[] = []

  subscribe(listener: WorkflowLiveListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  read(executionId: string): WorkflowLiveExecution | undefined {
    return this.executions.get(executionId)
  }

  /** Signals a durable change (control, completion, recovery) to watchers. */
  touch(executionId: string): void {
    this.emit(executionId, 'state')
  }

  progress(executionId: string, event: { phase?: string; message?: string }): void {
    const entry = this.entry(executionId)
    if (event.phase !== undefined) {
      entry.phase = event.phase
    }
    if (event.message !== undefined) {
      entry.log.push(event.message)
      if (entry.log.length > WORKFLOW_LIVE_LOG_LIMIT) {
        entry.log.splice(0, entry.log.length - WORKFLOW_LIVE_LOG_LIMIT)
      }
    }
    this.emit(executionId, 'state')
  }

  /** The program asked for this call; it waits for a host slot. */
  queued(executionId: string, callId: string, seatId: string): void {
    const entry = this.entry(executionId)
    entry.seats.set(callId, seatId)
    const current = entry.calls.get(callId)
    entry.calls.set(callId, {
      ...(current ?? { tail: '', outputChars: 0 }),
      seatId,
      phase: 'waiting',
      reason: 'slot'
    })
    this.emit(executionId, 'state')
  }

  /** A slot was granted; the durable store now replays or reserves an attempt. */
  acquired(executionId: string, callId: string): void {
    const call = this.call(executionId, callId)
    call.phase = 'starting'
    delete call.reason
    this.emit(executionId, 'state')
  }

  /** Durable state took over (accepted, failed, cached or cancelled). */
  settled(executionId: string, callId: string): void {
    if (this.executions.get(executionId)?.calls.delete(callId)) {
      this.emit(executionId, 'state')
    }
  }

  /**
   * The program runs again from its start (resume or Retry) and reports its phases and log again,
   * so the previous run's log and calls are dropped. Seats stay: call ids keep their seat.
   * Recovery replays silently and keeps what is here.
   */
  restart(executionId: string): void {
    this.unfinish(executionId)
    const entry = this.executions.get(executionId)
    if (entry) {
      delete entry.phase
      entry.log = []
      entry.calls.clear()
    }
  }

  /** The execution stopped running; any leftover call entries are stale. */
  finish(executionId: string): void {
    const entry = this.executions.get(executionId)
    if (entry?.calls.size) {
      entry.calls.clear()
    }
    this.unfinish(executionId)
    this.finished.push(executionId)
    // A long session runs many workflows; only the most recent keep their live leftovers.
    while (this.finished.length > WORKFLOW_LIVE_FINISHED_LIMIT) {
      this.executions.delete(this.finished.shift()!)
    }
    this.emit(executionId, 'state')
  }

  observer(executionId: string): WorkflowLiveObserver {
    return {
      waiting: (callId, reason) => {
        const call = this.call(executionId, callId)
        call.phase = 'waiting'
        call.reason = reason
        this.emit(executionId, 'state')
      },
      starting: (callId, attemptId) => {
        const call = this.call(executionId, callId)
        if (call.attemptId !== attemptId) {
          // A new attempt starts from an empty tail; the previous attempt's text is history.
          call.attemptId = attemptId
          call.tail = ''
          call.outputChars = 0
          delete call.tokens
          delete call.activity
          delete call.startedAt
        }
        call.phase = 'starting'
        delete call.reason
        this.emit(executionId, 'state')
      },
      spawned: (callId, attemptId, at) => {
        const call = this.current(executionId, callId, attemptId)
        if (call) {
          call.phase = 'running'
          call.startedAt = at
          this.emit(executionId, 'state')
        }
      },
      update: (callId, attemptId, update) => {
        const call = this.current(executionId, callId, attemptId)
        if (call && applyUpdate(call, update)) {
          this.emit(executionId, 'output')
        }
      },
      exited: (callId, attemptId) => {
        const call = this.current(executionId, callId, attemptId)
        if (call) {
          call.phase = 'finishing'
          this.emit(executionId, 'state')
        }
      }
    }
  }

  private unfinish(executionId: string): void {
    const index = this.finished.indexOf(executionId)
    if (index !== -1) {
      this.finished.splice(index, 1)
    }
  }

  private entry(executionId: string): WorkflowLiveExecution {
    let entry = this.executions.get(executionId)
    if (!entry) {
      entry = { log: [], calls: new Map(), seats: new Map() }
      this.executions.set(executionId, entry)
    }
    return entry
  }

  private call(executionId: string, callId: string): WorkflowLiveCall {
    const entry = this.entry(executionId)
    let call = entry.calls.get(callId)
    if (!call) {
      call = { seatId: entry.seats.get(callId), phase: 'waiting', tail: '', outputChars: 0 }
      entry.calls.set(callId, call)
    }
    return call
  }

  /** Signals from an attempt that is no longer current are dropped, never merged. */
  private current(
    executionId: string,
    callId: string,
    attemptId: string
  ): WorkflowLiveCall | undefined {
    const call = this.executions.get(executionId)?.calls.get(callId)
    if (!call) {
      return undefined
    }
    if (call.attemptId === undefined) {
      call.attemptId = attemptId
    }
    return call.attemptId === attemptId ? call : undefined
  }

  private emit(executionId: string, change: WorkflowLiveChange): void {
    for (const listener of this.listeners) {
      try {
        listener(executionId, change)
      } catch {
        // A failing watcher must not break the run that feeds it.
      }
    }
  }
}

function applyUpdate(call: WorkflowLiveCall, update: WorkflowLiveUpdate): boolean {
  let changed = false
  if (update.activity !== undefined && update.activity !== call.activity) {
    call.activity = update.activity
    changed = true
  }
  if (update.text) {
    call.outputChars += update.text.length
    const tail = call.tail + update.text
    call.tail =
      tail.length > WORKFLOW_LIVE_TAIL_LIMIT ? tail.slice(-WORKFLOW_LIVE_TAIL_LIMIT) : tail
    changed = true
  }
  if (update.tokens) {
    call.tokens = { input: update.tokens.input, output: update.tokens.output }
    changed = true
  }
  return changed
}
