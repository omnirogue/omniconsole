import { describe, expect, it } from 'vitest'
import { handoffPackageOf, handoffPackageReferences } from './console-handoff-disposition-reference'

const file = (name: string, current = true) => ({ name, current })

describe('what a thread says about its own package', () => {
  it('points at the generated summary and transcript beside the disposition', () => {
    expect(
      handoffPackageReferences({
        disposition: 'feedback',
        summaryFile: 'session-op.md',
        transcriptFile: 'transcript-x.md'
      })
    ).toEqual([
      { kind: 'disposition', ref: 'feedback' },
      { kind: 'summary-file', ref: 'session-op.md' },
      { kind: 'transcript-file', ref: 'transcript-x.md' }
    ])
    expect(handoffPackageReferences({})).toEqual([])
  })

  it('sets the summary and the transcript apart from the work', () => {
    const files = [
      file('report.md'),
      file('session-op.md'),
      file('transcript-x.md'),
      file('old.md', false)
    ]
    const references = handoffPackageReferences({
      disposition: 'feedback',
      summaryFile: 'session-op.md',
      transcriptFile: 'transcript-x.md'
    })
    expect(handoffPackageOf({ entries: [{ references }], files })).toEqual({
      disposition: 'feedback',
      summary: files[1],
      transcript: files[2],
      work: [files[0]]
    })
  })

  it('reads a thread sent before the pointers existed by its generated file names', () => {
    const summary = file('session-a3a985e8-b892-48d5-bcb1-c0f36c2ceb58.md')
    const transcript = file(
      'transcript-f97ea49d-10c4-4d45-b8c1-731db370b44f-20260918-d81667e912dbad52.md'
    )
    const work = file('session-notes.md')
    expect(
      handoffPackageOf({ entries: [{ references: [] }], files: [work, summary, transcript] })
    ).toEqual({ disposition: null, summary, transcript, work: [work] })
  })

  it('reads the readable generated names the same way when a thread has no pointers', () => {
    const summary = file('Summary - Write ads - 2026-09-18 130924.md')
    const transcript = file('Conversation transcript - Write ads - 2026-09-18 130924.md')
    const work = file('Summary of Q3.md')
    expect(
      handoffPackageOf({ entries: [{ references: [] }], files: [work, summary, transcript] })
    ).toEqual({ disposition: null, summary, transcript, work: [work] })
  })

  it('never guesses by name once the sender has spoken', () => {
    const lookalike = file('session-a3a985e8-b892-48d5-bcb1-c0f36c2ceb58.md')
    expect(
      handoffPackageOf({
        entries: [{ references: [{ kind: 'summary-file', ref: 'gone.md' }] }],
        files: [lookalike]
      })
    ).toMatchObject({ summary: null, work: [lookalike] })
  })
})
