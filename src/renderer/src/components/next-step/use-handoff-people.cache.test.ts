import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedHandoffRead,
  HANDOFF_PEOPLE_READ_TTL_MS,
  resetHandoffPeopleReads
} from './use-handoff-people'

vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({}),
  companiesErrorMessage: () => '',
  useCompaniesRead: () => ({ data: null, error: null, loading: false, reload: () => undefined })
}))
vi.mock('@/components/companies/use-work-folders', () => ({
  useWorkFolders: () => ({ data: null, error: null, loading: false, reload: () => undefined })
}))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => ({}) }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'scope' }))

describe('handoff people read cache', () => {
  beforeEach(() => resetHandoffPeopleReads())
  it('answers repeated hovers from one read, then reads again once the answer is a minute old', async () => {
    const read = vi.fn(async () => ({ ok: true as const, data: ['a'] }))
    await cachedHandoffRead('roster:s', read, 1_000)
    await cachedHandoffRead('roster:s', read, 1_000 + HANDOFF_PEOPLE_READ_TTL_MS - 1)
    expect(read).toHaveBeenCalledTimes(1)
    await cachedHandoffRead('roster:s', read, 1_000 + HANDOFF_PEOPLE_READ_TTL_MS)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('does not keep a failed answer', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'x' } })
      .mockResolvedValueOnce({ ok: true, data: [] })
    await cachedHandoffRead('me:s', read, 5)
    await cachedHandoffRead('me:s', read, 6)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
