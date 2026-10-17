import { describe, expect, it } from 'vitest'
import { routineMatchesQuery } from './routine-list-filter'

describe('routineMatchesQuery', () => {
  const routine = { name: 'Advertising check', prompt: 'Review campaign conversions' }
  it.each(['', '  ', 'ADVERTISING', ' campaign ', 'conversions'])('matches %j', (query) => {
    expect(routineMatchesQuery(routine, query)).toBe(true)
  })
  it('rejects unrelated and oversized queries', () => {
    expect(routineMatchesQuery(routine, 'nightly')).toBe(false)
    expect(routineMatchesQuery(routine, 'a'.repeat(3000))).toBe(false)
  })
})
