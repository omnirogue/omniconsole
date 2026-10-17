// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useTaskDraft } from './use-task-draft'

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  companies: [] as object[],
  loading: false
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) => selector(fixture.state)
}))
beforeEach(() => {
  fixture.state = {}
  fixture.companies = []
  fixture.loading = false
})
vi.mock('@/components/companies/use-work-folders', () => ({
  useWorkFoldersScope: () => 'person',
  useWorkFolders: () => ({ data: { companies: fixture.companies }, loading: fixture.loading })
}))
vi.mock('@/lib/company-folder-home', () => ({ getCompanyFolderHome: async () => '/home/person' }))

it('retains the chosen goal for edits and clears it when company or department changes', () => {
  const { result } = renderHook(() =>
    useTaskDraft(null, {
      companyId: 'co_rogue',
      unitId: 'org_dev',
      goalId: 'cgl_reliability',
      projectId: 'proj_product'
    })
  )
  act(() => result.current.set({ title: 'Reliable IDE' }))
  expect(result.current.draft.goalId).toBe('cgl_reliability')
  act(() => result.current.set({ unitId: 'org_ops' }))
  expect(result.current.draft).toMatchObject({
    companyId: 'co_rogue',
    unitId: 'org_ops',
    goalId: '',
    projectId: ''
  })
  act(() => result.current.set({ goalId: 'cgl_ops' }))
  act(() => result.current.set({ companyId: 'co_os' }))
  expect(result.current.draft).toMatchObject({
    companyId: 'co_os',
    unitId: '',
    goalId: '',
    projectId: ''
  })
})

it('fills the active folder company after loading without replacing the typed title', async () => {
  fixture.state = {
    activeWorktreeId: 'wt-1',
    settings: { companyFolders: { omnirogue: '/work/rogue' } },
    worktreesByRepo: { repo: [{ id: 'wt-1', path: '/work/rogue/Development' }] }
  }
  const { result, rerender } = renderHook(() => useTaskDraft(null))
  act(() => result.current.set({ title: 'My edited title' }))
  fixture.companies = [
    {
      id: 'co_rogue',
      slug: 'omnirogue',
      name: 'OmniRogue',
      domains: [{ id: 'org_dev', name: 'Development' }]
    }
  ]
  rerender()
  await waitFor(() => expect(result.current.draft.companyId).toBe('co_rogue'))
  expect(result.current.draft).toMatchObject({ title: 'My edited title', unitId: 'org_dev' })
  act(() => result.current.set({ companyId: '' }))
  rerender()
  expect(result.current.draft.companyId).toBe('')
})

it('resolves a company slug after title edits without assigning an unrelated folder department', async () => {
  const { result, rerender } = renderHook(() => useTaskDraft(null, { companySlug: ' OmniRogue ' }))
  act(() => result.current.set({ title: 'Keep this title' }))
  fixture.companies = [{ id: 'co_rogue', slug: 'omnirogue', domains: [] }]
  rerender()
  await waitFor(() =>
    expect(result.current.draft).toMatchObject({ title: 'Keep this title', companyId: 'co_rogue' })
  )
})
