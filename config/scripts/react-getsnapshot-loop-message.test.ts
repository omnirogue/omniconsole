import { describe, expect, it } from 'vitest'
import {
  GET_SNAPSHOT_LOOP_MESSAGE,
  isReactGetSnapshotLoopMessage
} from './react-getsnapshot-loop-message'

describe('isReactGetSnapshotLoopMessage', () => {
  it('detects the React warning in a string argument', () => {
    expect(isReactGetSnapshotLoopMessage([`Warning: ${GET_SNAPSHOT_LOOP_MESSAGE}`])).toBe(true)
  })

  it('detects the React warning wrapped in an Error', () => {
    expect(isReactGetSnapshotLoopMessage([new Error(GET_SNAPSHOT_LOOP_MESSAGE)])).toBe(true)
  })

  it('ignores unrelated console.error output', () => {
    expect(isReactGetSnapshotLoopMessage(['Maximum update depth exceeded', 42, null])).toBe(false)
  })
})
