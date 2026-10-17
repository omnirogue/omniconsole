import { describe, expect, it } from 'vitest'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { buildCompanyTree, companyTreeKey, domainTreeKey } from './company-tree'
import type { SidebarSession } from './sidebar-sessions'

function session(id: string, label: string, worktreeId: string): SidebarSession {
  return {
    rowKey: `row:${id}`,
    sessionKey: `session:${id}`,
    worktreeId,
    hostId: null,
    tabId: `tab:${id}`,
    paneKey: `pane:${id}`,
    kind: 'terminal',
    label,
    workspaceLabel: worktreeId,
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}

const HOME = '/Users/maintainer'
const companies = [
  {
    id: 'c-omnirogue',
    slug: 'omnirogue',
    name: 'OmniRogue',
    status: null,
    count: 3,
    domains: [
      { id: 'd-sales', name: 'Sales', count: 1, parent_unit_id: null },
      { id: 'd-dev', name: 'Development', count: 2, parent_unit_id: null }
    ]
  },
  { id: 'c-acme', slug: 'acme', name: 'ACME', status: null, count: 0, domains: [] }
]

function build(overrides: Partial<Parameters<typeof buildCompanyTree>[0]> = {}) {
  return buildCompanyTree({
    companies,
    sessions: [],
    pathByWorktreeId: new Map(),
    stateByPaneKey: new Map(),
    attentionByPaneKey: new Map(),
    waitingUntilByPaneKey: new Map(),
    home: HOME,
    workRoot: null,
    overrides: null,
    ...overrides
  })
}

describe('buildCompanyTree', () => {
  it('files a conversation under the deepest folder it runs in', () => {
    const rows = [
      session('a', 'Pricing page', 'wt-sales'),
      session('b', 'Nightly build', 'wt-root'),
      session('c', 'Scratch', 'wt-elsewhere')
    ]
    const tree = build({
      sessions: rows,
      pathByWorktreeId: new Map([
        ['wt-sales', `${HOME}/Work/OmniRogue/Sales/pricing`],
        ['wt-root', `${HOME}/Work/OmniRogue`],
        ['wt-elsewhere', `${HOME}/Desktop/scratch`]
      ])
    })
    const omnirogue = tree.companies[0]!
    expect(omnirogue.key).toBe(companyTreeKey('omnirogue'))
    expect(omnirogue.folder).toBe(`${HOME}/Work/OmniRogue`)
    const sales = omnirogue.domains.find((d) => d.name === 'Sales')!
    expect(sales.key).toBe(domainTreeKey('omnirogue', { id: 'd-sales', name: 'Sales' }))
    expect(sales.conversations.map((row) => row.session.label)).toEqual(['Pricing page'])
    expect(omnirogue.conversations.map((row) => row.session.label)).toEqual(['Nightly build'])
    expect(tree.companies[1]!.conversations).toEqual([])
    expect(tree.unfiled.map((row) => row.session.label)).toEqual(['Scratch'])
  })

  it('puts what needs the person first and counts it up the tree', () => {
    const rows = [
      session('idle', 'Idle chat', 'wt'),
      session('ask', 'Waiting on approval', 'wt'),
      session('busy', 'Refactor', 'wt')
    ]
    const tree = build({
      sessions: rows,
      pathByWorktreeId: new Map([['wt', `${HOME}/Work/OmniRogue/Development`]]),
      stateByPaneKey: new Map([
        ['pane:idle', 'idle'],
        ['pane:ask', 'blocked'],
        ['pane:busy', 'working']
      ]),
      attentionByPaneKey: new Map([['pane:ask', { paneKey: 'pane:ask' } as AttentionPane]])
    })
    const dev = tree.companies[0]!.domains.find((d) => d.name === 'Development')!
    expect(dev.conversations.map((row) => row.state)).toEqual(['needs-you', 'working', 'inactive'])
    expect(dev.needsYou).toBe(1)
    expect(dev.working).toBe(1)
    expect(tree.companies[0]!.needsYou).toBe(1)
    expect(tree.companies[0]!.working).toBe(1)
  })

  it('keeps waiting conversations out of every node and its counts', () => {
    const rows = [session('w', 'Later', 'wt')]
    const tree = build({
      sessions: rows,
      pathByWorktreeId: new Map([['wt', `${HOME}/Work/OmniRogue`]]),
      attentionByPaneKey: new Map([['pane:w', { paneKey: 'pane:w' } as AttentionPane]]),
      waitingUntilByPaneKey: new Map([['pane:w', '2026-09-13T09:00:00.000Z']])
    })
    expect(tree.companies[0]!.conversations).toEqual([])
    expect(tree.companies[0]!.needsYou).toBe(0)
    expect(tree.waiting.map((row) => row.session.label)).toEqual(['Later'])
    expect(tree.waiting[0]!.state).toBe('waiting')
    expect(tree.waiting[0]!.waitingUntil).toBe('2026-09-13T09:00:00.000Z')
  })

  it('honours a configured folder override for a company', () => {
    const rows = [session('o', 'Ops', 'wt')]
    const tree = build({
      sessions: rows,
      overrides: { omnirogue: '~/Clients/rogue' },
      pathByWorktreeId: new Map([['wt', `${HOME}/Clients/rogue/api`]])
    })
    expect(tree.companies[0]!.folder).toBe(`${HOME}/Clients/rogue`)
    expect(tree.companies[0]!.conversations.map((row) => row.session.label)).toEqual(['Ops'])
  })

  it('keeps the hub order and names a company by its id when it carries nothing else', () => {
    const tree = build({
      companies: [
        ...companies,
        { id: 'c-3', slug: null, name: null, status: null, count: 0, domains: [] },
        { id: '', slug: null, name: null, status: null, count: 0, domains: [] }
      ]
    })
    expect(tree.companies.map((company) => company.slug)).toEqual(['omnirogue', 'acme', 'c3'])
    expect(tree.companies[2]!.name).toBe('c3')
  })
})

import { conversationPlanFixture } from './conversation-plan-fixture'

it('counts a current plan as working and leaves superseded attempts out of needs-you', () => {
  const chain = conversationPlanFixture()
  chain.planVersion = 2
  chain.outcomeSet!.attempts[0]!.state = 'blocked'
  chain.outcomeSet!.attempts[1]!.planVersion = 2
  const row = session('plan', 'Plan', 'wt-root')
  const tree = build({
    sessions: [row],
    chainByRowKey: new Map([[row.rowKey, chain]]),
    pathByWorktreeId: new Map([['wt-root', `${HOME}/Work/OmniRogue`]])
  })
  expect(tree.companies[0]).toMatchObject({ working: 1, needsYou: 0 })
  expect(tree.companies[0]!.conversations[0]!.state).toBe('running')
})

describe('plan conversations count for the person only through a request', () => {
  const now = 1_000_000_000
  const row = session('plan', 'Plan', 'wt-root')
  const worker = session('worker', 'Worker', 'wt-root')
  const paths = new Map([['wt-root', `${HOME}/Work/OmniRogue`]])
  const stopped = (paneKey: string): AttentionPane =>
    ({
      paneKey,
      portalPaneKey: paneKey,
      cause: 'waiting',
      worktreeId: 'wt-root',
      stateChangedAt: 5
    }) as AttentionPane

  function stalled() {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    return chain
  }

  it('reads a stalled plan as failed, not needs-you, even with its pane in the list', () => {
    const tree = build({
      now,
      sessions: [row],
      chainByRowKey: new Map([[row.rowKey, stalled()]]),
      attentionByPaneKey: new Map([[row.paneKey!, stopped(row.paneKey!)]]),
      pathByWorktreeId: paths
    })
    expect(tree.companies[0]).toMatchObject({ needsYou: 0, working: 0 })
    expect(tree.companies[0]!.conversations[0]!.state).toBe('failed')
  })

  it('counts a run with an open request once, on the conversation that owns it', () => {
    const chain = stalled()
    chain.outcomeSet!.attention = [
      {
        id: 'att_review-findings_outcome_1',
        kind: 'decision',
        scope: { outcomeId: 'outcome', outcomeRevision: 1 },
        ask: 'Decide what happens to 2 open review findings.',
        why: 'All 2 authorized review rounds are used; another one needs your say.',
        recipient: { type: 'owner' },
        source: { type: 'review-findings', ref: 'rounds:2' },
        state: 'open',
        openedAt: 5
      }
    ]
    // Why: the list carries the request on the worker's pane; that row must not count it again.
    const listed: AttentionPane = {
      ...stopped(worker.paneKey!),
      run: {
        chainId: chain.id,
        sourceRowKey: row.rowKey,
        headline: 'Needs you: Decide what happens to 2 open review findings.',
        why: 'All 2 authorized review rounds are used; another one needs your say.',
        requests: chain.outcomeSet!.attention
      }
    }
    const tree = build({
      now,
      sessions: [row, worker],
      chainByRowKey: new Map([[row.rowKey, chain]]),
      attentionByPaneKey: new Map([[worker.paneKey!, listed]]),
      pathByWorktreeId: paths
    })
    expect(tree.companies[0]!.needsYou).toBe(1)
    expect(
      tree.companies[0]!.conversations.map((entry) => [entry.session.label, entry.state])
    ).toEqual([
      ['Plan', 'needs-you'],
      ['Worker', 'none']
    ])
  })

  it('reads a sealed plan as done through a lost host', () => {
    const chain = stalled()
    chain.outcomeSet!.completion = {
      at: 50,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    const tree = build({
      now,
      sessions: [row],
      chainByRowKey: new Map([[row.rowKey, chain]]),
      pathByWorktreeId: paths
    })
    expect(tree.companies[0]).toMatchObject({ needsYou: 0, working: 0 })
    expect(tree.companies[0]!.conversations[0]!.state).toBe('done')
  })
})
