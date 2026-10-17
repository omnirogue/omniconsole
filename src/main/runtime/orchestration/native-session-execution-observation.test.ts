import { describe, expect, it } from 'vitest'
import {
  buildNativeSessionCheckpointObservation,
  buildNativeSessionStartObservation,
  buildNativeSessionStopObservation
} from './native-session-execution-observation'

const record = { sessionId: 'session-alpha', hubTaskId: 'btk_1234' }
const cursor = { epoch: 'journal-epoch-1', sequence: 17 }

describe('native session checkpoint observation', () => {
  it('reports the real native session-created epoch without an orchestration row', () => {
    const created = { epoch: cursor.epoch, sequence: 1 }
    expect(buildNativeSessionStartObservation({ record, cursor: created })).toEqual({
      hubTaskId: 'btk_1234',
      runId: 'session-alpha',
      journalCursor: `native-session:session-alpha:${JSON.stringify(created)}`,
      event: 'run_started',
      detail: 'Native structured session session-alpha; durable session-created journal epoch'
    })
  })

  it('uses the persisted session as the executor identity and preserves the durable cursor', () => {
    expect(buildNativeSessionCheckpointObservation({ record, cursor })).toEqual({
      hubTaskId: 'btk_1234',
      runId: 'session-alpha',
      journalCursor: `native-session:session-alpha:${JSON.stringify(cursor)}`,
      event: 'checkpoint_written',
      detail: 'Native structured session session-alpha; turn-boundary journal checkpoint'
    })
  })

  it('leaves an unbound native session local', () => {
    expect(
      buildNativeSessionCheckpointObservation({ record: { sessionId: record.sessionId }, cursor })
    ).toBeNull()
  })

  it.each([
    { ...cursor, sequence: 0 },
    { ...cursor, sequence: -1 },
    { ...cursor, sequence: 1.5 },
    { ...cursor, sequence: Number.NaN },
    { ...cursor, epoch: '' }
  ])('refuses a cursor that cannot identify a persisted row: %j', (invalid) => {
    expect(() => buildNativeSessionCheckpointObservation({ record, cursor: invalid })).toThrow(
      'Invalid native session checkpoint identity'
    )
  })

  it('refuses invalid persisted binding identifiers rather than deriving a substitute', () => {
    expect(() =>
      buildNativeSessionCheckpointObservation({
        record: { ...record, hubTaskId: 'workspace-title' },
        cursor
      })
    ).toThrow('Invalid native session checkpoint identity')
    expect(() =>
      buildNativeSessionCheckpointObservation({
        record: { ...record, sessionId: 'session\ninjected' },
        cursor
      })
    ).toThrow('Invalid native session checkpoint identity')
  })
})

describe('native closeout identity', () => {
  it('distinguishes repeated execution fences at the same journal position', () => {
    const build = (runtimeFence: number) =>
      buildNativeSessionStopObservation({
        record: { ...record, lease: { runtimeFence } },
        cursor
      })
    expect(build(1)).toEqual(build(1))
    expect(build(1)?.event).toBe('stop_confirmed')
    expect(build(1)?.journalCursor).not.toEqual(build(2)?.journalCursor)
    expect(build(1)?.detail).toContain('Task completion is not asserted')
    expect(() => build(0)).toThrow('closeout fence')
  })
})
