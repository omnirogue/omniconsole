import { vi, type Mock } from 'vitest'
import { resetCompanyFolderHomeCache } from '@/lib/company-folder-home'
import type { ConsoleCompaniesApi } from '../../../../shared/console-companies-contract'
import type { ConsoleWorkflowResult } from '../../../../shared/console-workflow-types'

export function ok<T>(data: T): ConsoleWorkflowResult<T> {
  return { ok: true, data }
}
export function refusal(code: string, message: string): ConsoleWorkflowResult<never> {
  return { ok: false, error: { code, message } }
}

export const rollupFixture = {
  ok: true,
  window_hours: 24,
  companies: [
    { company_id: 'omnirogue', slug: 'omnirogue', name: 'OmniRogue', active: 4, failed: 1 },
    { company_id: 'betacorp', slug: 'betacorp', name: 'BetaCorp', active: 2, failed: 0 }
  ]
}
export const healthFixture = {
  generated_at: '2026-09-11T09:00:00Z',
  timezone: 'UTC',
  companies: [
    {
      id: 'c-omnirogue',
      slug: 'omnirogue',
      name: 'OmniRogue',
      status: 'healthy',
      href: '/c/omnirogue',
      summary: 'Revenue is ahead of plan.',
      domains: [
        {
          id: 'dom_ads',
          parent_unit_id: null,
          kind: 'advertising',
          name: 'Advertising',
          status: 'warning',
          href: '/c/omnirogue/advertising',
          summary: 'Cost per lead is rising.',
          metrics: [
            {
              id: 'm1',
              key: 'cpl',
              label: 'Cost per lead',
              actual: 31,
              unit: 'usd',
              status: 'warning',
              summary: 'Above the $30 ceiling.',
              coverage: { state: 'complete', detail: 'All active ad sets.' },
              evidence: []
            }
          ],
          headline_metrics: [],
          changes: [],
          actions: []
        }
      ],
      headline_metrics: [
        {
          id: 'm0',
          key: 'revenue',
          label: 'Revenue',
          actual: 48000,
          unit: 'usd',
          status: 'healthy',
          summary: 'Month to date.',
          coverage: { state: 'complete', detail: 'Books through yesterday.' },
          evidence: []
        }
      ],
      changes: [],
      actions: [],
      domain_summary: { healthy: 2, attention: 1, unknown: 0, unconfigured: 0, total: 3 }
    }
  ]
}
export const missionsFixture = {
  ok: true,
  missions: {
    available: true,
    items: [{ id: 'mis_1', title: 'Scale winning ads', company_id: 'omnirogue', status: 'active' }]
  },
  queue: { available: true, items: [] }
}
export const companyFixture = {
  ok: true,
  company_id: 'omnirogue',
  cockpit: {
    available: true,
    value: {
      human_work: { count: 3, top: [{ title: 'Approve the Q3 pack' }], has_more: false },
      ai_work: { count: 7, top: [], has_more: false },
      waiting_blocked: { count: 0, top: [], has_more: false },
      missions: { by_state: { active: 2, planned: 1 }, top: [] },
      domains_ready: true,
      domains_ratio: 1,
      dispatch_paused: false,
      objectives: []
    }
  },
  goals: {
    available: true,
    items: [
      {
        id: 'goal_1',
        title: 'Double enterprise revenue',
        status: 'active',
        horizon: 'quarter',
        owner_employee_id: 'emp_sal',
        org_unit_id: 'dom_ads'
      },
      {
        id: 'goal_2',
        title: 'Ship the new onboarding',
        status: 'planned',
        horizon: 'year',
        owner_employee_id: null,
        org_unit_id: 'dom_eng'
      }
    ]
  }
}
export const orgFixture = {
  ok: true,
  companies: [
    {
      id: 'omnirogue',
      slug: 'omnirogue',
      name: 'OmniRogue',
      available: true,
      domains: [
        { id: 'dom_ads', name: 'Advertising', workstreams: ['meta', 'creative'] },
        { id: 'dom_eng', name: 'Development', workstreams: ['platform'] }
      ]
    }
  ]
}
export const meFixture = {
  ok: true,
  user: { id: 'u1', name: 'Sal', email: 'sal@example.com', role: 'admin' },
  sections: [],
  pages: [],
  companies: null,
  company_scope: 'all'
}
export const orgChartFixture = {
  people: [
    { id: 'p1', name: 'Sal', title: 'Founder', email: 'sal@example.com' },
    { id: 'p2', name: 'Iris', title: 'Ads', email: 'iris@example.com' },
    { id: 'p3', name: 'Uma', title: 'Platform', email: 'uma@example.com' }
  ],
  units: [
    {
      id: 'dom_ads',
      name: 'Advertising',
      kind: 'department',
      lead_person_id: 'p1',
      member_ids: ['p2']
    }
  ]
}
export const accountingFixture = {
  company: 'omnirogue',
  name: 'OmniRogue',
  generated_at: '2026-09-11T09:00:00Z',
  bank: {
    status: 'ready',
    last_synced_at: '2026-09-11T08:00:00Z',
    last_attempt_at: '2026-09-11T08:00:00Z',
    error: null,
    accounts: [
      {
        id: 'acc_1',
        name: 'Operating',
        kind: 'checking',
        mask: '4321',
        currency: 'USD',
        cash_available_minor: 125000,
        cash_posted_minor: 125000,
        credit_available_minor: null,
        credit_posted_minor: null,
        credit_owed_minor: null
      }
    ],
    transactions: [
      {
        id: 'txn_1',
        account_id: 'acc_1',
        occurred_at: '2026-09-10T12:00:00Z',
        description: 'Stripe payout',
        amount_minor: 250000,
        currency: 'USD',
        status: 'posted',
        detailed_status: 'settled',
        ledger: 'cash',
        source_url: null
      }
    ],
    coverage: { from: '2026-08-01', to: '2026-09-11', complete: true }
  },
  books: {
    status: 'ready',
    last_synced_at: null,
    company_name: 'OmniRogue Inc',
    realm_id: null,
    connection_url: 'https://omnios.test/connect',
    note: null
  },
  automation: { task_url: null, task_title: null, status: 'active', source: 'bank', note: null }
}

// Why: annotate the mock explicitly — an inferred vitest spy type cannot be named
// in this module's declaration (TS2883), which fails the composed typecheck.
type CompaniesApiMock = { [K in keyof ConsoleCompaniesApi]: Mock }

export const companiesApiMock: CompaniesApiMock = {
  rollup: vi.fn(),
  scorecard: vi.fn(),
  me: vi.fn(),
  orgChart: vi.fn(),
  missions: vi.fn(),
  today: vi.fn(),
  org: vi.fn(),
  folders: vi.fn(),
  company: vi.fn(),
  health: vi.fn(),
  accounting: vi.fn(),
  syncAccounting: vi.fn(),
  transactionsCsv: vi.fn()
}

/** The desktop's company-folder surface: a known home and a folder that exists. */
// Why: annotate explicitly — an inferred vitest spy type cannot be named in this
// module's declaration (TS2883) and fails the composed typecheck.
export const companyWorkspacesMock: { home: Mock; ensureFolder: Mock } = {
  home: vi.fn(),
  ensureFolder: vi.fn()
}
export const folderPathStatusMock: Mock = vi.fn()

/** The signed desktop answering every read, as the preload bridge would. */
export function installCompaniesWindowApi(): void {
  resetCompanyFolderHomeCache()
  for (const operation of Object.values(companiesApiMock)) {
    operation.mockReset()
  }
  companiesApiMock.rollup.mockResolvedValue(ok(rollupFixture))
  companiesApiMock.missions.mockResolvedValue(ok(missionsFixture))
  companiesApiMock.today.mockResolvedValue(ok({ ok: true }))
  companiesApiMock.org.mockResolvedValue(ok(orgFixture))
  // Why: the folder tree names every fixture company, so a test that expects a
  // company on screen is not filtered away; the filter has its own test.
  companiesApiMock.folders.mockResolvedValue(
    ok({
      ok: true,
      companies: [
        ...orgFixture.companies.map((company) => ({
          id: company.id ?? null,
          slug: company.slug ?? null,
          name: company.name ?? null,
          status: 'active'
        })),
        ...rollupFixture.companies.map((company) => ({
          id: company.company_id ?? null,
          slug: company.slug ?? null,
          name: company.name ?? null,
          status: 'active'
        }))
      ]
    })
  )
  companiesApiMock.me.mockResolvedValue(ok(meFixture))
  companiesApiMock.orgChart.mockResolvedValue(ok(orgChartFixture))
  companiesApiMock.company.mockResolvedValue(ok(companyFixture))
  companiesApiMock.health.mockResolvedValue(ok(healthFixture))
  companiesApiMock.accounting.mockImplementation((args: { company: string }) =>
    Promise.resolve(
      args.company === 'omnirogue'
        ? ok(accountingFixture)
        : refusal('capability_unavailable', 'No books for this company.')
    )
  )
  companiesApiMock.syncAccounting.mockResolvedValue(ok({ queued: true }))
  companyWorkspacesMock.home.mockReset()
  companyWorkspacesMock.ensureFolder.mockReset()
  companyWorkspacesMock.home.mockResolvedValue('/Users/maintainer')
  companyWorkspacesMock.ensureFolder.mockResolvedValue({ ok: true, created: true })
  folderPathStatusMock.mockReset()
  folderPathStatusMock.mockResolvedValue({ path: '', exists: true })
  companiesApiMock.transactionsCsv.mockResolvedValue(
    ok({ company: 'omnirogue', filename: 'omnirogue-bank-transactions.csv', csv: 'date,amount\n' })
  )
  Object.assign(window as unknown as { api: unknown }, {
    api: {
      consoleCompanies: companiesApiMock,
      shell: { openUrl: vi.fn() },
      companyWorkspaces: companyWorkspacesMock,
      folderWorkspaces: { getPathStatus: folderPathStatusMock }
    }
  })
}
