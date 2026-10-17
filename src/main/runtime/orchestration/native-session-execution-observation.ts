import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { OrchestrationExecutionObservation } from '../../../shared/orchestration-execution-observation'
import { HUB_TASK_ID_PATTERN } from '../../../shared/omnios-task-binding'

type NativeSessionObservationInput = {
  record: Pick<AgentSessionRecord, 'sessionId' | 'hubTaskId'>
  cursor: AgentJournalCursor
}

export function buildNativeSessionCheckpointObservation(
  input: NativeSessionObservationInput
): OrchestrationExecutionObservation | null {
  return buildNativeSessionObservation(input, 'checkpoint_written')
}

export function buildNativeSessionStartObservation(
  input: NativeSessionObservationInput
): OrchestrationExecutionObservation | null {
  return buildNativeSessionObservation(input, 'run_started')
}

function buildNativeSessionObservation(
  input: NativeSessionObservationInput,
  event: 'checkpoint_written' | 'run_started'
): OrchestrationExecutionObservation | null {
  const { record, cursor } = input
  if (!record.hubTaskId) {
    return null
  }
  if (
    !HUB_TASK_ID_PATTERN.test(record.hubTaskId) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.sessionId) ||
    !cursor.epoch.trim() ||
    cursor.epoch.length > 128 ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 1
  ) {
    throw new Error('Invalid native session checkpoint identity')
  }
  return {
    hubTaskId: record.hubTaskId,
    runId: record.sessionId,
    journalCursor: `native-session:${record.sessionId}:${JSON.stringify(cursor)}`,
    event,
    detail: `Native structured session ${record.sessionId}; ${
      event === 'run_started'
        ? 'durable session-created journal epoch'
        : 'turn-boundary journal checkpoint'
    }`
  }
}

/** Only the teardown path with confirmed provider exit may call this builder. */
export function buildNativeSessionStopObservation(
  input: NativeSessionObservationInput & {
    record: NativeSessionObservationInput['record'] & { lease: { runtimeFence: number } }
  }
): OrchestrationExecutionObservation | null {
  const base = buildNativeSessionObservation(input, 'checkpoint_written')
  if (!base) {
    return null
  }
  const fence = input.record.lease.runtimeFence
  if (!Number.isSafeInteger(fence) || fence < 1) {
    throw new Error('Invalid native closeout fence')
  }
  return {
    ...base,
    event: 'stop_confirmed',
    journalCursor: `${base.journalCursor}:closeout-fence:${fence}`,
    detail:
      'Provider exit confirmed; operational closeout retained. Task completion is not asserted. No WIS lesson is proposed by this automatic closeout.'
  }
}
