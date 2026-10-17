import { watchNativeTaskSave } from './native-task-save-invalidation'
import {
  publishNativeTaskSave,
  recordNativeTaskSaveFailure,
  beginNativeTaskRetention
} from './native-task-save-status'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type {
  NativeJournalObservation,
  NativeJournalPublicationCallbacks
} from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import {
  buildNativeSessionCheckpointObservation,
  buildNativeSessionStartObservation,
  buildNativeSessionStopObservation
} from '../runtime/orchestration/native-session-execution-observation'
import { currentConsolePublicationScope } from './console-workflow-person'
import {
  recoverNativeTaskPublications,
  retainNativeTaskObservation
} from './native-task-publication'

const retries = new WeakMap<
  AgentSessionJournal,
  { timer: ReturnType<typeof setInterval>; wake: () => void; input: NativeJournalObservation }
>()

/** Release-owner switch; enable only after verifying the typed-note replay receiver. */
export function nativeTaskPublicationEnabled(): boolean {
  return process.env.OMNI_NATIVE_TASK_SAVE_DELIVERY === '1'
}

export function resumeNativeTaskPublication(input: NativeJournalObservation): void {
  if (!nativeTaskPublicationEnabled()) {
    return
  }
  if (input.readOnly) {
    publishNativeTaskSave(input)
    return
  }
  watchNativeTaskSave(input)
  const existing = retries.get(input.journal)
  if (existing) {
    if (
      watchNativeTaskSave(existing.input) &&
      existing.input.record.lease.runtimeFence === input.record.lease.runtimeFence &&
      input.record.hubTaskId &&
      existing.input.isCurrent(input.record.hubTaskId)
    ) {
      existing.wake()
      return
    }
    clearInterval(existing.timer)
    retries.delete(input.journal)
  }
  let running = false
  let requested = false
  const stop = () => {
    const timer = retries.get(input.journal)
    if (timer?.input !== input) {
      return
    }
    if (timer) {
      clearInterval(timer.timer)
    }
    retries.delete(input.journal)
  }
  const recover = async () => {
    if (running) {
      requested = true
      return
    }
    const pending = input.journal.taskPublications().filter((row) => row.noteId === null)
    if (!nativeTaskPublicationEnabled() || !pending.some((row) => input.isCurrent(row.taskId))) {
      if (nativeTaskPublicationEnabled()) {
        publishNativeTaskSave(input)
      }
      stop()
      return
    }
    running = true
    try {
      await recoverNativeTaskPublications(
        input.journal,
        input.record.lease.runtimeFence,
        input.isCurrent
      )
      publishNativeTaskSave(input)
      if (!input.journal.taskPublications().some((row) => row.noteId === null)) {
        stop()
      }
    } catch {
      recordNativeTaskSaveFailure(input)
      console.warn('[omnios] Native task progress sharing needs recovery.')
    } finally {
      running = false
      if (requested && retries.get(input.journal)?.input === input) {
        requested = false
        void recover()
      }
    }
  }
  const timer = setInterval(() => {
    void recover()
  }, 30_000)
  timer.unref()
  retries.set(input.journal, { timer, wake: () => void recover(), input })
  void recover()
}

export async function retainNativeJournalObservation(
  input: NativeJournalObservation,
  event: 'run_started' | 'checkpoint_written' | 'stop_confirmed'
): Promise<void> {
  if (input.readOnly) {
    throw new Error('A history-only session cannot write task notes.')
  }
  const observation =
    event === 'run_started'
      ? buildNativeSessionStartObservation(input)
      : event === 'stop_confirmed'
        ? buildNativeSessionStopObservation(input)
        : buildNativeSessionCheckpointObservation(input)
  if (!observation) {
    return
  }
  const finishRetention = beginNativeTaskRetention(input)
  try {
    const scope = currentConsolePublicationScope()
    if (!scope) {
      throw new Error('Sign in before sharing native task progress.')
    }
    await retainNativeTaskObservation(
      input.journal,
      observation,
      {
        ...scope,
        isCurrent: () => input.isCurrent(observation.hubTaskId)
      },
      input.record.lease.runtimeFence
    )
    finishRetention(true)
  } catch (error) {
    finishRetention(false)
    throw error
  }
  resumeNativeTaskPublication(input)
}

export const nativeJournalPublicationCallbacks: NativeJournalPublicationCallbacks = {
  enabled: nativeTaskPublicationEnabled,
  onReady: resumeNativeTaskPublication,
  onStopped: (input) => retainNativeJournalObservation(input, 'stop_confirmed'),
  onStarted: (input) => retainNativeJournalObservation(input, 'run_started'),
  onCheckpoint: (input) => retainNativeJournalObservation(input, 'checkpoint_written')
}
