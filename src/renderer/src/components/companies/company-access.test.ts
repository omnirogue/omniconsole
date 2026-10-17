// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { companiesApiMock, installCompaniesWindowApi, ok, refusal } from './companies-test-fixtures'
import { companyAccessSummary, useCompanyAccess, useCompanyFolderSet } from './company-access'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, options?: Record<string, unknown>) =>
    options
      ? text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
      : text,
  i18n: { language: 'en' }
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      activeOrcaProfileId: 'profile-1',
      settings: {
        backofficeEnv: 'production',
        backofficeLocalUrl: '',
        backofficeProductionUrl: 'https://omnios.test'
      }
    })
}))

beforeEach(() => {
  installCompaniesWindowApi()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('the company scope the desktop honours', () => {
  // Why this is the load-bearing test: the previous version answered "allows
  // everything" whenever /api/me failed, so a single console error showed a
  // reader every company the folder tree returned.
  it('allows nothing when the scope cannot be read', async () => {
    companiesApiMock.me.mockResolvedValue(refusal('backoffice_refused', 'no'))
    const { result } = renderHook(() => useCompanyAccess())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.scope).toBe('unknown')
    expect(result.current.allows('omnirogue')).toBe(false)
    expect(result.current.allows('c-omnirogue', 'omnirogue')).toBe(false)
    expect(companyAccessSummary(result.current)).toContain('nothing is listed')
  })

  it('allows only the named companies when the console names a list', async () => {
    companiesApiMock.me.mockResolvedValue(
      ok({ ok: true, company_scope: 'list', companies: ['omnirogue'] })
    )
    const { result } = renderHook(() => useCompanyAccess())
    await waitFor(() => expect(result.current.scope).toBe('some'))
    expect(result.current.allows('omnirogue')).toBe(true)
    expect(result.current.allows('betacorp')).toBe(false)
    expect(result.current.count).toBe(1)
  })

  it('matches a company by either its id or its slug', async () => {
    companiesApiMock.me.mockResolvedValue(
      ok({ ok: true, company_scope: 'list', companies: ['c-omnirogue'] })
    )
    const { result } = renderHook(() => useCompanyAccess())
    await waitFor(() => expect(result.current.scope).toBe('some'))
    expect(result.current.allows('c-omnirogue', 'omnirogue')).toBe(true)
    expect(result.current.allows('c-betacorp', 'betacorp')).toBe(false)
  })

  it('gives a super admin the whole estate on the scope word alone', async () => {
    companiesApiMock.me.mockResolvedValue(ok({ ok: true, company_scope: 'all', companies: [] }))
    const { result } = renderHook(() => useCompanyAccess())
    await waitFor(() => expect(result.current.scope).toBe('all'))
    expect(result.current.allows('anything-at-all')).toBe(true)
  })

  it('keeps a null company list meaning the whole estate', async () => {
    companiesApiMock.me.mockResolvedValue(ok({ ok: true, companies: null }))
    const { result } = renderHook(() => useCompanyAccess())
    await waitFor(() => expect(result.current.scope).toBe('all'))
    expect(result.current.allows('omnirogue')).toBe(true)
  })

  it('allows nothing while an empty list is the answer', async () => {
    companiesApiMock.me.mockResolvedValue(
      ok({ ok: true, company_scope: 'department', companies: [] })
    )
    const { result } = renderHook(() => useCompanyAccess())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.allows('omnirogue')).toBe(false)
  })
})

describe('the companies the folder tree names', () => {
  it('matches nothing when the tree cannot be read', async () => {
    companiesApiMock.folders.mockResolvedValue(refusal('invalid_request', 'no'))
    const { result } = renderHook(() => useCompanyFolderSet())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.known).toBe(false)
    expect(result.current.has('omnirogue')).toBe(false)
  })

  it('matches only the companies the tree returned', async () => {
    companiesApiMock.folders.mockResolvedValue(
      ok({
        ok: true,
        companies: [
          { id: 'c-omnirogue', slug: 'omnirogue', name: 'OmniRogue', count: 2, domains: [] }
        ]
      })
    )
    const { result } = renderHook(() => useCompanyFolderSet())
    await waitFor(() => expect(result.current.known).toBe(true))
    expect(result.current.has('omnirogue')).toBe(true)
    expect(result.current.has('c-omnirogue')).toBe(true)
    expect(result.current.has('betacorp')).toBe(false)
  })
})
