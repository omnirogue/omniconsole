import { describe, expect, it } from 'vitest'
import { decideConsoleAutoAdvance } from './console-auto-advance-decision'
import {
  autoAdvanceDigest,
  autoAdvanceJob,
  autoAdvanceWorkflowId
} from './console-auto-advance-test-fixture'

const worktree = 'id:wt-console-1'
const base = {
  workflowId: autoAdvanceWorkflowId,
  enabled: true,
  worktree,
  activated: new Set<string>()
}

describe('console auto-advance decision', () => {
  it('activates one ready local AI job with its approved digest', () => {
    expect(
      decideConsoleAutoAdvance({
        ...base,
        jobs: [
          autoAdvanceJob({ id: 'job_research1', workflowState: 'done', status: 'done' }),
          autoAdvanceJob({ id: 'job_planning1' }),
          autoAdvanceJob({ id: 'job_building1', workflowState: 'blocked' })
        ]
      })
    ).toEqual({ action: 'activate', jobId: 'job_planning1', digest: autoAdvanceDigest })
  })

  it('skips a job that is not exactly ready or is already running', () => {
    for (const job of [
      autoAdvanceJob({ id: 'job_planning1', workflowState: 'blocked' }),
      autoAdvanceJob({ id: 'job_planning1', status: 'running' }),
      autoAdvanceJob({ id: 'job_planning1', blockers: ['awaiting merge'] }),
      autoAdvanceJob({ id: 'job_planning1', skipped: 'condition' })
    ]) {
      expect(
        decideConsoleAutoAdvance({ ...base, jobs: [job] }).action,
        JSON.stringify(job.workflow_state + job.status)
      ).not.toBe('activate')
    }
  })

  it('never activates a job it already activated in this run', () => {
    // The server may not have flipped the row yet; waiting is right, a second activation is not.
    expect(
      decideConsoleAutoAdvance({
        ...base,
        activated: new Set(['job_planning1']),
        jobs: [autoAdvanceJob({ id: 'job_planning1' })]
      })
    ).toEqual({ action: 'wait', jobId: 'job_planning1' })
  })

  it('stops at a human decision row before any activation', () => {
    expect(
      decideConsoleAutoAdvance({
        ...base,
        jobs: [
          autoAdvanceJob({ id: 'job_approval1', actorType: 'human', canDecide: true }),
          autoAdvanceJob({ id: 'job_planning1' })
        ]
      })
    ).toEqual({ action: 'stop', reason: 'human_decision', jobId: 'job_approval1' })
  })

  it('leaves a fleet-placed ready job to the hub', () => {
    expect(
      decideConsoleAutoAdvance({
        ...base,
        jobs: [autoAdvanceJob({ id: 'job_building1', placement: 'fleet' })]
      })
    ).toEqual({ action: 'stop', reason: 'fleet_placement', jobId: 'job_building1' })
    const unplaced = autoAdvanceJob({ id: 'job_building1' })
    delete unplaced.policy.workflow.placement
    expect(decideConsoleAutoAdvance({ ...base, jobs: [unplaced] })).toMatchObject({
      action: 'stop',
      reason: 'fleet_placement'
    })
  })

  it('refuses a folder workspace, a missing workspace and a preference that is off', () => {
    const jobs = [autoAdvanceJob({ id: 'job_planning1' })]
    expect(decideConsoleAutoAdvance({ ...base, enabled: false, jobs })).toEqual({
      action: 'stop',
      reason: 'turned_off',
      jobId: null
    })
    expect(decideConsoleAutoAdvance({ ...base, worktree: '', jobs })).toMatchObject({
      reason: 'no_workspace'
    })
    expect(decideConsoleAutoAdvance({ ...base, worktree: 'id:folder:fw-1', jobs })).toMatchObject({
      reason: 'folder_workspace'
    })
  })

  it('ignores rows belonging to another workflow and waits while work is unfinished', () => {
    expect(
      decideConsoleAutoAdvance({
        ...base,
        jobs: [
          autoAdvanceJob({ id: 'job_other111', workflowId: 'wf_other' }),
          autoAdvanceJob({ id: 'job_building1', status: 'running', workflowState: 'running' })
        ]
      })
    ).toEqual({ action: 'wait', jobId: 'job_building1' })
  })
})
