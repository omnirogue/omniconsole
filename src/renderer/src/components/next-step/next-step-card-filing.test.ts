import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveNextStepCardFiling, resolveNextStepPlace } from './next-step-card-filing'

/**
 * Why this test exists: a card created without a company, department and goal is a stray
 * the hub refuses to dispatch ("Complete the task's company, goal and department"). The
 * desktop knows where the conversation lives on disk, so it must file the card itself —
 * and when it cannot, create nothing and say so.
 */
const mocks = vi.hoisted(() => ({
  path: '/Users/maintainer/Work/ApexLabs/Advertising/campaign' as string | null,
  folders: vi.fn(),
  company: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { companyWorkRoot: '~/Work' },
      getKnownWorktreeById: () => (mocks.path ? { path: mocks.path } : undefined)
    })
  }
}))
vi.mock('@/lib/company-folder-home', () => ({
  getCompanyFolderHome: async () => '/Users/maintainer'
}))
vi.mock('@/components/companies/use-work-folders', () => ({
  readWorkFolders: mocks.folders,
  workFoldersScope: () => 'scope'
}))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({ company: mocks.company }),
  companiesData: (result: { ok: boolean; data: unknown; error?: { message: string } }) => {
    if (!result.ok) {
      throw new Error(result.error?.message ?? 'refused')
    }
    return result.data
  }
}))

function goals(items: unknown[]) {
  mocks.company.mockResolvedValue({
    ok: true,
    data: { goals: { available: true, items } }
  })
}

beforeEach(() => {
  mocks.path = '/Users/maintainer/Work/ApexLabs/Advertising/campaign'
  mocks.folders.mockReset()
  mocks.company.mockReset()
  mocks.folders.mockResolvedValue({
    ok: true,
    companies: [
      {
        id: 'cmp_click',
        slug: 'apexlabs',
        name: 'ApexLabs',
        domains: [
          { id: 'dom_ads', name: 'Advertising' },
          { id: 'dom_eng', name: 'Engineering' }
        ]
      }
    ]
  })
  goals([{ id: 'cgl_q4', title: 'Q4 revenue', org_unit_id: 'dom_ads', status: 'active' }])
})

describe('where a conversation is filed, by name', () => {
  it('names the company and department whose folder the workspace sits in', async () => {
    expect(await resolveNextStepPlace('wt')).toMatchObject({
      company: { id: 'cmp_click', name: 'ApexLabs' },
      domain: { id: 'dom_ads', name: 'Advertising' }
    })
  })

  it('names the company alone from its root and nothing outside every company', async () => {
    mocks.path = '/Users/maintainer/Work/ApexLabs'
    const root = await resolveNextStepPlace('wt')
    expect(root?.company.name).toBe('ApexLabs')
    expect(root?.domain).toBeNull()
    mocks.path = '/Users/maintainer/Scratch/experiment'
    expect(await resolveNextStepPlace('wt')).toBeNull()
    mocks.path = null
    expect(await resolveNextStepPlace('wt')).toBeNull()
  })
})

describe('where a new card is filed', () => {
  it('files by the company folder the conversation lives in, down to the department', async () => {
    expect(await resolveNextStepCardFiling('wt')).toEqual({
      filing: { companyId: 'cmp_click', unitId: 'dom_ads', goalId: 'cgl_q4' }
    })
  })

  it('takes the department’s first active goal and ignores goals of other departments', async () => {
    goals([
      { id: 'cgl_other', title: 'Ship v2', org_unit_id: 'dom_eng', status: 'active' },
      { id: 'cgl_done', title: 'Last quarter', org_unit_id: 'dom_ads', status: 'completed' },
      { id: 'cgl_open', title: 'This quarter', org_unit_id: 'dom_ads', status: 'active' }
    ])
    const result = await resolveNextStepCardFiling('wt')
    expect('filing' in result && result.filing.goalId).toBe('cgl_open')
  })

  // Why: the hub takes one status and no synonym — "goal_id must name an ACTIVE goal of
  // this company" — and a paused goal on the card had the create refused outright.
  it('accepts only an exactly active goal, never paused or archived', async () => {
    goals([
      { id: 'cgl_paused', title: 'On hold', org_unit_id: 'dom_ads', status: 'paused' },
      { id: 'cgl_arch', title: 'Old', org_unit_id: 'dom_ads', status: 'archived' },
      { id: 'cgl_live', title: 'Live', org_unit_id: 'dom_ads', status: ' Active ' }
    ])
    const result = await resolveNextStepCardFiling('wt')
    expect('filing' in result && result.filing.goalId).toBe('cgl_live')
  })

  it('refuses a department whose goals are only paused or archived, and names it', async () => {
    goals([
      { id: 'cgl_paused', title: 'On hold', org_unit_id: 'dom_ads', status: 'paused' },
      { id: 'cgl_arch1', title: 'Old', org_unit_id: 'dom_ads', status: 'archived' },
      { id: 'cgl_arch2', title: 'Older', org_unit_id: 'dom_ads', status: 'archived' }
    ])
    const result = await resolveNextStepCardFiling('wt')
    expect('refusal' in result && result.refusal.reason).toContain('company, goal and department')
    expect('refusal' in result && result.refusal.reason).toContain(
      'Advertising has no active goal.'
    )
  })

  it('prefers a goal this conversation is already tied to, when that one is active too', async () => {
    goals([
      { id: 'cgl_first', title: 'First', org_unit_id: 'dom_ads', status: 'active' },
      { id: 'cgl_linked', title: 'Linked', org_unit_id: 'dom_ads', status: 'active' }
    ])
    const result = await resolveNextStepCardFiling('wt', 'cgl_linked')
    expect('filing' in result && result.filing.goalId).toBe('cgl_linked')
  })

  it('falls back to the first active goal when the conversation’s own is paused', async () => {
    goals([
      { id: 'cgl_first', title: 'First', org_unit_id: 'dom_ads', status: 'active' },
      { id: 'cgl_linked', title: 'Linked', org_unit_id: 'dom_ads', status: 'paused' }
    ])
    const result = await resolveNextStepCardFiling('wt', 'cgl_linked')
    expect('filing' in result && result.filing.goalId).toBe('cgl_first')
  })

  // Why: outside every company folder the desktop does not know the place, and a guess
  // would file real work in front of the wrong people.
  it('refuses a workspace outside every company folder', async () => {
    mocks.path = '/Users/maintainer/Scratch/experiment'
    const result = await resolveNextStepCardFiling('wt')
    expect('refusal' in result && result.refusal.reason).toContain('company, goal and department')
    expect('refusal' in result && result.refusal.actionUrl).toContain('/work')
    expect(mocks.company).not.toHaveBeenCalled()
  })

  it('refuses a conversation in the company root, which names no department', async () => {
    mocks.path = '/Users/maintainer/Work/ApexLabs'
    expect('refusal' in (await resolveNextStepCardFiling('wt'))).toBe(true)
  })

  it('refuses when the department has no goal at all', async () => {
    goals([])
    expect('refusal' in (await resolveNextStepCardFiling('wt'))).toBe(true)
  })

  it('files under a place the person chose instead of the folder’s, without reading the tree', async () => {
    goals([
      { id: 'cgl_ads', title: 'Ads', org_unit_id: 'dom_ads', status: 'active' },
      { id: 'cgl_eng', title: 'Ship v2', org_unit_id: 'dom_eng', status: 'active' }
    ])
    expect(
      await resolveNextStepCardFiling('wt', null, {
        companyId: 'cmp_click',
        unitId: 'dom_eng',
        unitName: 'Engineering'
      })
    ).toEqual({ filing: { companyId: 'cmp_click', unitId: 'dom_eng', goalId: 'cgl_eng' } })
    expect(mocks.folders).not.toHaveBeenCalled()
  })

  it('names the chosen department when it has no active goal', async () => {
    goals([{ id: 'cgl_ads', title: 'Ads', org_unit_id: 'dom_ads', status: 'active' }])
    const result = await resolveNextStepCardFiling('wt', null, {
      companyId: 'cmp_click',
      unitId: 'dom_eng',
      unitName: 'Engineering'
    })
    expect('refusal' in result && result.refusal.reason).toContain(
      'Engineering has no active goal.'
    )
  })

  it('refuses a workspace whose path this desktop does not know', async () => {
    mocks.path = null
    expect('refusal' in (await resolveNextStepCardFiling('wt'))).toBe(true)
    expect(mocks.folders).not.toHaveBeenCalled()
  })
})
