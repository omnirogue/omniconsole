import { describe, expect, it } from 'vitest'
import { teamMemoryStatusCopy } from './team-memory-status-copy'

describe('teamMemoryStatusCopy', () => {
  it('shows both revisions when loaded', () => {
    expect(
      teamMemoryStatusCopy({
        state: 'loaded',
        everyoneRevision: 3,
        personalRevision: 1,
        indexOverBudget: false,
        checkedAt: 1
      })
    ).toMatchObject({ tone: 'connected', label: 'Team memory: loaded (everyone r3 · yours r1)' })
  })

  it('turns to attention when the index is over budget, keeping the revisions', () => {
    const copy = teamMemoryStatusCopy({
      state: 'loaded',
      everyoneRevision: 3,
      personalRevision: null,
      indexOverBudget: true,
      checkedAt: 1
    })
    expect(copy.tone).toBe('attention')
    expect(copy.label).toBe('Team memory: loaded (everyone r3 · yours –)')
    expect(copy.detail).toContain('over budget')
  })

  it('names the reason when not loaded', () => {
    const reasons = {
      not_signed_in: 'not signed in',
      no_employee_mapping: 'no employee mapping',
      request_failed: 'request failed',
      not_loaded: 'not in connector'
    } as const
    for (const [reason, words] of Object.entries(reasons)) {
      expect(
        teamMemoryStatusCopy({
          state: 'not_loaded',
          reason: reason as keyof typeof reasons,
          checkedAt: 1
        })
      ).toMatchObject({ tone: 'attention', label: `Team memory: not loaded — ${words}` })
    }
    expect(teamMemoryStatusCopy({ state: 'unknown' }).tone).toBe('neutral')
  })
})
