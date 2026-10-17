import { describe, expect, it } from 'vitest'
import { countWorkflowNotes, workflowRunNoteEntries } from './workflow-run-notes'

/**
 * Why these tests exist: Discover logs each line its caps drop and also keeps them in its run, so
 * the same line reached the page twice while the live log lasted and once after a restart.
 */
describe('workflow run notes', () => {
  const cap = 'Round 1: the finder left out 2 more findings beyond its limit of 8.'

  it('counts each line once, as often as the fuller source says', () => {
    const entries = workflowRunNoteEntries(['Scout mapped 2 areas.', cap], [cap, cap])
    expect(countWorkflowNotes(entries)).toEqual([
      ['Scout mapped 2 areas.', 1],
      [cap, 2]
    ])
  })

  it('keeps the dropped work when the live log is gone, and the log when nothing was dropped', () => {
    expect(countWorkflowNotes(workflowRunNoteEntries(undefined, [cap]))).toEqual([[cap, 1]])
    expect(workflowRunNoteEntries(['Round 2 started.'], undefined)).toEqual(['Round 2 started.'])
    expect(workflowRunNoteEntries()).toEqual([])
  })

  it('never lowers a count the live log already has', () => {
    expect(countWorkflowNotes(workflowRunNoteEntries([cap, cap, cap], [cap]))).toEqual([[cap, 3]])
  })
})
