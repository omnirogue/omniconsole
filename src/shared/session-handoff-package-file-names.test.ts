import { describe, expect, it } from 'vitest'
import { handoffPackageFileNames } from './session-handoff-package-file-names'

const now = new Date(2026, 8, 18, 13, 9, 24)
const free = async (): Promise<boolean> => false

describe('handoffPackageFileNames', () => {
  it('names the summary and the transcript for the same topic and moment', async () => {
    expect(await handoffPackageFileNames({ topic: 'Write ads', clashes: free, now })).toEqual({
      summary: 'Summary - Write ads - 2026-09-18 130924.md',
      transcript: 'Conversation transcript - Write ads - 2026-09-18 130924.md'
    })
  })

  it('takes the next free second when the folder holds other work under this second’s names', async () => {
    const held = new Set([
      'Conversation transcript - Write ads - 2026-09-18 130924.md',
      'Summary - Write ads - 2026-09-18 130925.md'
    ])
    expect(
      await handoffPackageFileNames({
        topic: 'Write ads',
        clashes: async (names) => held.has(names.summary) || held.has(names.transcript),
        now
      })
    ).toEqual({
      summary: 'Summary - Write ads - 2026-09-18 130926.md',
      transcript: 'Conversation transcript - Write ads - 2026-09-18 130926.md'
    })
  })

  it('keeps round one’s names on a later round, whatever the folder holds', async () => {
    expect(
      await handoffPackageFileNames({
        topic: 'Something else',
        keptSummaryName: 'Summary - Write ads - 2026-09-18 090000.md',
        clashes: async () => true,
        now
      })
    ).toEqual({
      summary: 'Summary - Write ads - 2026-09-18 090000.md',
      transcript: 'Conversation transcript - Write ads - 2026-09-18 090000.md'
    })
  })
})
