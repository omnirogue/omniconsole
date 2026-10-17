import { describe, expect, it } from 'vitest'
import { buildBackofficeReviewNote } from './backoffice-review-note'

describe('buildBackofficeReviewNote', () => {
  it('projects a reviewer verdict as a progress note with evidence and no completion verb', () => {
    const body = buildBackofficeReviewNote({
      hubTaskId: 'btk_abc123',
      pipelineId: 'brp_1',
      runId: 'run_1',
      round: 2,
      event: 'review_verdict',
      worker: 'claude (opus, high)',
      verdict: 'REQUEST_CHANGES',
      reportPath: '/wt/.omni/reports/review-1.md',
      detail: 'Missing test for the empty case'
    })
    expect(body.note_kind).toBe('progress')
    expect(body.payload.summary).toBe('Build + Review: reviewer verdict')
    expect(body.payload.done).toEqual([])
    expect(body.payload.evidence).toEqual(
      expect.arrayContaining([
        { kind: 'text', ref: 'brp_1', label: 'IDE Build+Review pipeline' },
        { kind: 'text', ref: 'round 2', label: 'Build+Review round' },
        { kind: 'text', ref: 'run_1', label: 'IDE run id' },
        { kind: 'text', ref: 'REQUEST_CHANGES', label: 'reviewer verdict' },
        { kind: 'file', ref: '/wt/.omni/reports/review-1.md', label: 'worker report' }
      ])
    )
    expect(body.note).toContain('Verdict: REQUEST_CHANGES')
    expect(body.note.toLowerCase()).not.toContain('complete_task')
  })

  it('says where acceptance lives when every reviewer approved', () => {
    const body = buildBackofficeReviewNote({
      hubTaskId: 'btk_abc123',
      pipelineId: 'brp_1',
      runId: null,
      round: 1,
      event: 'review_approved',
      filesModified: ['src/a.ts', 'src/b.ts']
    })
    expect(body.payload.summary).toContain('candidate for verification')
    expect(body.note).toContain('Acceptance is decided on this card')
    expect(body.payload.evidence.filter((item) => item.label === 'modified file')).toHaveLength(2)
  })

  it('refuses anything that is not a card id', () => {
    expect(() =>
      buildBackofficeReviewNote({
        hubTaskId: 'task_local',
        pipelineId: 'brp_1',
        runId: null,
        round: 1,
        event: 'build_reported'
      })
    ).toThrow(/card id/)
  })
})
