import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import type { SessionOwnerDeps } from './session-manage-owner'
import type { SessionOwnerPastDeps } from './session-manage-owner-past'

export type SessionOwnerTimingRecorder = ReturnType<typeof createWorktreeCreateTimingRecorder>

/** Reuse the monotonic recorder; overlapping candidate spans must not be summed as wall time. */
export const createSessionOwnerTimingRecorder = createWorktreeCreateTimingRecorder

export function timedSessionOwnerDeps(
  deps: SessionOwnerDeps,
  timing: SessionOwnerTimingRecorder
): SessionOwnerDeps {
  return {
    search: (task) => timing.time('transcript-search', () => deps.search(task)),
    changes: (live) => timing.time('file-conflicts', () => deps.changes(live)),
    goal: (row) => timing.time('live-goal', () => deps.goal(row)),
    judge: (task, session) => timing.time('live-jev', () => deps.judge(task, session))
  }
}

export function timedSessionOwnerPastDeps(
  deps: SessionOwnerPastDeps,
  timing: SessionOwnerTimingRecorder
): SessionOwnerPastDeps {
  return {
    observe: (row) => timing.time('past-observation', () => deps.observe(row)),
    organization: (reference) =>
      timing.time('past-organization', () => deps.organization(reference)),
    goal: (hit) => timing.time('past-goal', () => deps.goal(hit)),
    judge: (task, session) => timing.time('past-jev', () => deps.judge(task, session))
  }
}
