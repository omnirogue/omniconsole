import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { waitLaterKeyForPane } from '@/lib/wait-later'
import type { ScorecardDocument } from '../../../../shared/console-scorecard-contract'
import {
  companyMoneyRows,
  countByState,
  formatMoney,
  moneyOf,
  portfolioToday,
  scorecardAgeMinutes,
  sessionActivities
} from './work-model'

function document(overrides: Partial<ScorecardDocument> = {}): ScorecardDocument {
  return {
    generated_at: '2026-09-11T22:00:00Z',
    today: '2026-09-11',
    ads_accounts: [],
    sources: [],
    companies: [
      {
        slug: 'omnirogue',
        name: 'OmniRogue',
        today: {
          reported: ['revenue', 'ad_spend', 'api_cost', 'pnl'],
          revenue: 1234.5,
          ad_spend: 300,
          api_cost: 42.25,
          pnl: 892.25,
          api_cost_available: true
        },
        days: [],
        sources: []
      },
      {
        slug: 'apexlabs',
        name: 'ApexLabs',
        // Why: no API-cost tenant, and the ad platform answered nothing today.
        today: {
          reported: ['revenue'],
          revenue: 0,
          ad_spend: 0,
          api_cost: null,
          pnl: 0,
          api_cost_available: false
        },
        days: [],
        sources: []
      }
    ],
    totals: {
      today: {
        reported: ['revenue', 'ad_spend', 'pnl'],
        revenue: 1234.5,
        ad_spend: 300,
        api_cost: null,
        pnl: 892.25
      }
    },
    finance: {
      omnirogue: {
        api_cost_today: { total: 40.1, requests: 12 },
        api_cost_7d: { total: 210, requests: 90 }
      }
    },
    ...overrides
  }
}

describe('moneyOf', () => {
  it('reports a value only when the source reported it', () => {
    expect(
      moneyOf({ reported: ['revenue'], revenue: 0, ad_spend: 0, api_cost: null, pnl: 0 }, 'revenue')
    ).toEqual({
      kind: 'value',
      value: 0
    })
    expect(
      moneyOf(
        { reported: ['revenue'], revenue: 0, ad_spend: 0, api_cost: null, pnl: 0 },
        'ad_spend'
      )
    ).toEqual({
      kind: 'unknown',
      reason: 'unreported'
    })
  })

  it('never invents an API cost for a company that reports none', () => {
    expect(
      moneyOf(
        {
          reported: ['api_cost'],
          revenue: 1,
          ad_spend: 1,
          api_cost: 0,
          pnl: 0,
          api_cost_available: false
        },
        'api_cost'
      )
    ).toEqual({ kind: 'unknown', reason: 'not-applicable' })
  })

  it('treats a legacy document without a report list as reported', () => {
    expect(moneyOf({ revenue: 5, ad_spend: 2, api_cost: 1, pnl: 2 }, 'pnl')).toEqual({
      kind: 'value',
      value: 2
    })
    expect(moneyOf(null, 'pnl')).toEqual({ kind: 'unknown', reason: 'missing' })
  })
})

describe('companyMoneyRows', () => {
  it('prefers the cost-analytics breakdown for today API cost and keeps unknowns unknown', () => {
    const rows = companyMoneyRows(document())
    expect(rows.map((row) => row.slug)).toEqual(['omnirogue', 'apexlabs'])
    expect(rows[0].today.api_cost).toEqual({ kind: 'value', value: 40.1 })
    expect(rows[0].apiCostSevenDays).toEqual({ kind: 'value', value: 210 })
    expect(rows[1].today.api_cost).toEqual({ kind: 'unknown', reason: 'not-applicable' })
    expect(rows[1].today.ad_spend).toEqual({ kind: 'unknown', reason: 'unreported' })
    expect(rows[1].apiCostSevenDays).toEqual({ kind: 'unknown', reason: 'missing' })
  })
})

describe('portfolioToday', () => {
  it('shows the estate day when the relay served the totals', () => {
    const portfolio = portfolioToday(document())
    expect(portfolio?.revenue).toEqual({ kind: 'value', value: 1234.5 })
    expect(portfolio?.api_cost).toEqual({ kind: 'unknown', reason: 'unreported' })
  })

  it('is absent when the relay pruned the document to the reader companies', () => {
    expect(
      portfolioToday(document({ scope: { companies: ['omnirogue'], totals_omitted: true } }))
    ).toBeNull()
    expect(portfolioToday(document({ totals: undefined }))).toBeNull()
  })
})

describe('formatMoney', () => {
  it('rounds large figures and signs P&L', () => {
    expect(formatMoney(1234.5)).toBe('$1,235')
    expect(formatMoney(42.25)).toBe('$42.25')
    expect(formatMoney(-12, { signed: true })).toBe('−$12.00')
    expect(formatMoney(892.25, { signed: true })).toBe('+$892')
  })
})

describe('scorecardAgeMinutes', () => {
  it('prefers the relay staleness over the generation time', () => {
    expect(scorecardAgeMinutes(document({ stale_s: 615 }), new Date('2026-09-11T23:00:00Z'))).toBe(
      10
    )
    expect(scorecardAgeMinutes(document(), new Date('2026-09-11T22:30:00Z'))).toBe(30)
  })
})

function session(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: null,
    worktreeId: 'wt',
    hostId: null,
    tabId: 'tab',
    paneKey: 'tab:leaf',
    kind: 'terminal',
    label: 'Session',
    workspaceLabel: 'Workspace',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function card(paneKey: string, bucket: AgentPaneCard['bucket'], stateChangedAt = 0): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'wt',
    tabId: 'tab',
    leafId: 'leaf',
    agentType: 'claude',
    bucket,
    dotState: 'idle',
    unseen: false,
    title: '',
    stateChangedAt,
    repoName: 'repo',
    worktreeName: 'wt'
  } as AgentPaneCard
}

describe('sessionActivities', () => {
  it('orders needs-you, working, waiting, finished, idle and lets a wait win', () => {
    const sessions = [
      session({ rowKey: 'idle', paneKey: 'p:idle', label: 'Idle' }),
      session({ rowKey: 'work', paneKey: 'p:work', label: 'Working' }),
      session({ rowKey: 'ask', paneKey: 'p:ask', label: 'Asking' }),
      session({ rowKey: 'wait', paneKey: 'p:wait', label: 'Waiting' }),
      session({ rowKey: 'done', paneKey: 'p:done', label: 'Done' })
    ]
    const cardsByPaneKey = new Map([
      ['p:work', card('p:work', 'working', 5)],
      ['p:ask', card('p:ask', 'attention', 7)],
      ['p:wait', card('p:wait', 'attention', 9)],
      ['p:done', card('p:done', 'done', 1)]
    ])
    const waitKey = waitLaterKeyForPane('p:wait')
    const rows = sessionActivities(
      sessions,
      { cardsByPaneKey },
      new Set([waitKey]),
      { [waitKey]: '2026-09-12T08:30:00Z' },
      new Map()
    )
    expect(rows.map((row) => `${row.session.rowKey}:${row.state}`)).toEqual([
      'ask:needs-you',
      'work:working',
      'wait:waiting',
      'done:finished',
      'idle:idle'
    ])
    expect(rows[2].until).toBe('2026-09-12T08:30:00Z')
    expect(countByState(rows)).toEqual({
      'needs-you': 1,
      working: 1,
      waiting: 1,
      finished: 1,
      idle: 1
    })
  })

  it('reads a run through the "needs you" list: a stopped worker is idle, a request marks its owner', () => {
    const sessions = [
      session({ rowKey: 'owner', paneKey: 'p:owner', label: 'Owner' }),
      session({ rowKey: 'worker', paneKey: 'p:worker', label: 'Worker' }),
      session({ rowKey: 'ask', paneKey: 'p:ask', label: 'Asking' }),
      session({ rowKey: 'put-away', paneKey: 'p:done', label: 'Called finished' })
    ]
    const cardsByPaneKey = new Map([
      ['p:owner', card('p:owner', 'working', 3)],
      // Why: the worker stopped and its hook says "waiting"; the run list left it out.
      ['p:worker', card('p:worker', 'attention', 5)],
      ['p:ask', card('p:ask', 'attention', 7)],
      ['p:done', card('p:done', 'attention', 9)]
    ])
    const listed = (paneKey: string) =>
      ({ ...card(paneKey, 'attention'), cause: 'waiting', portalPaneKey: paneKey }) as AttentionPane
    const attention: AttentionPane[] = [
      listed('p:ask'),
      {
        ...listed('p:worker-2'),
        run: {
          chainId: 'chain',
          sourceRowKey: 'owner',
          headline: 'Needs you: Sign claude in again.',
          why: 'Only you hold those credentials.',
          requests: []
        }
      }
    ]
    const rows = sessionActivities(
      sessions,
      { cardsByPaneKey, attention },
      new Set(),
      {},
      new Map([[waitLaterKeyForPane('p:done'), 10]])
    )
    expect(Object.fromEntries(rows.map((row) => [row.session.rowKey, row.state]))).toEqual({
      owner: 'needs-you',
      worker: 'idle',
      ask: 'needs-you',
      // Why: a pane the person called finished left the list by their hand, not by a run's.
      'put-away': 'needs-you'
    })
  })
})
