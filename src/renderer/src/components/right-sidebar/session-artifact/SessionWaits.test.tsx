// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeCondition
} from '../../../../../shared/session-outcome-types'
import { SessionWaits } from './SessionWaits'

const mocks = vi.hoisted(() => ({
  chain: null as unknown,
  choose: vi.fn(),
  set: vi.fn(),
  publish: vi.fn(),
  open: vi.fn()
}))
vi.mock('@/lib/session-chain-registry', () => ({
  useSessionChainForRow: (rowKey: string | null) => (rowKey === 'row' ? mocks.chain : null),
  setSessionChainEntry: mocks.set,
  publishSessionChains: mocks.publish
}))
vi.mock('@/components/next-step/next-step-outcome-client', () => ({
  chooseSessionOutcomeWait: mocks.choose
}))
vi.mock('@/lib/http-link-routing', () => ({ openHttpLink: mocks.open }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const NOW = Date.parse('2026-09-24T12:00:00Z')
const session = { rowKey: 'row', worktreeId: 'wt', label: 'Chat' } as unknown as SidebarSession
const slack = (personName: string, personId: string): SessionOutcomeCondition['event'] => ({
  source: 'slack',
  match: 'approve',
  personId,
  personName,
  ref: 'slack:C1:1.2',
  since: '2026-09-24T11:00:00Z'
})

function outcome(patch: Partial<SessionOutcome>): SessionOutcome {
  return {
    id: 'o',
    title: 'o',
    finish: 'complete',
    dependsOn: [],
    conditions: [],
    actions: [],
    revision: 2,
    status: 'pending',
    evidence: [],
    ...patch
  } as SessionOutcome
}

function action(id: string, instruction: string) {
  return {
    id,
    instruction,
    conditionIds: ['done'],
    authority: 'existing-user-authority' as const,
    agent: 'claude' as const
  }
}

function plan(iris: 'pending' | 'needs_you' = 'pending'): SessionChain {
  const approvals = outcome({
    id: 'approvals',
    conditions: [
      { id: 'uma', kind: 'event', target: 'uma', event: slack('Uma', 'emp_uma') },
      { id: 'iris', kind: 'event', target: 'iris', event: slack('Iris', 'emp_iris') },
      {
        id: 'pr',
        kind: 'event',
        target: 'pr',
        event: { source: 'github', match: 'merged', ref: 'https://github.com/a/b/pull/12' }
      }
    ],
    evidence: [
      {
        id: 'ev',
        outcomeId: 'approvals',
        conditionId: 'uma',
        outcomeRevision: 2,
        conditionKey: 'k',
        kind: 'event',
        target: 'uma',
        receipt: 'slack:ok',
        verifiedAt: NOW - 60_000,
        verifier: 'execution-host'
      }
    ],
    waits: [
      {
        conditionId: 'uma',
        status: 'met',
        checkedAt: NOW - 60_000,
        excerpt: 'Approved, go ahead',
        link: 'https://slack.com/archives/C1/p1',
        at: NOW - 90_000
      },
      {
        conditionId: 'iris',
        status: iris,
        checkedAt: NOW - 20_000,
        ...(iris === 'needs_you' ? { excerpt: 'Not yet, wait for Monday' } : {})
      }
    ]
  })
  return {
    id: 'chain',
    outcomeSet: {
      revision: 7,
      sessionFinish: { action: 'end' },
      outcomes: [
        outcome({ id: 'close', dependsOn: ['upgrade'], actions: [action('a2', 'Tidy up')] }),
        approvals,
        outcome({
          id: 'upgrade',
          dependsOn: ['approvals'],
          status: 'satisfied',
          actions: [action('a1', "Upgrade Iris's account")]
        }),
        outcome({ id: 'unrelated', actions: [action('a3', 'Unrelated work')] })
      ]
    }
  } as unknown as SessionChain
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  mocks.chain = null
  vi.clearAllMocks()
})

it('renders nothing when the plan waits on nobody', () => {
  mocks.chain = {
    id: 'c',
    outcomeSet: {
      revision: 1,
      outcomes: [outcome({ conditions: [{ id: 'f', kind: 'file', target: 'x' }] })]
    }
  }
  const { container } = render(<SessionWaits session={session} visible />)
  expect(container.innerHTML).toBe('')
})

it('lists who it waits on, where, and what came back', () => {
  mocks.chain = plan()
  render(<SessionWaits session={session} visible />)
  const rows = [...document.querySelectorAll('[data-session-wait]')]
  expect(rows.map((row) => row.getAttribute('data-session-wait'))).toEqual([
    'met',
    'pending',
    'pending'
  ])
  expect(rows[0]!.textContent).toContain('Uma')
  expect(rows[0]!.textContent).toContain('on Slack')
  expect(rows[0]!.textContent).toContain('“Approved, go ahead”')
  expect(rows[1]!.textContent).toContain('Iris')
  expect(rows[1]!.textContent).toContain('checked 20 s ago')
  expect(rows[2]!.textContent).toContain('PR #12 to merge')
  fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!)
  expect(mocks.open).toHaveBeenCalledWith('https://slack.com/archives/C1/p1', {
    worktreeId: 'wt',
    modifierHeld: false
  })
  expect(screen.getByText('Change this plan by telling the agent in chat.')).toBeTruthy()
})

it('lists what runs after the wait in dependency order, then how the session ends', () => {
  mocks.chain = plan()
  render(<SessionWaits session={session} visible />)
  const then = [...document.querySelectorAll('ol li')].map((item) => item.textContent)
  expect(then).toEqual(["✓“Upgrade Iris's account”", '“Tidy up”', 'Then: close this session'])
  expect(screen.queryByText(/Unrelated work/)).toBeNull()
})

it('asks the owner about an answer that was not a yes, and cancels only once confirmed', async () => {
  mocks.chain = plan('needs_you')
  mocks.choose.mockResolvedValue({ id: 'chain' })
  render(<SessionWaits session={session} visible />)
  expect(screen.getByText('Needs you')).toBeTruthy()
  expect(screen.getByText('“Not yet, wait for Monday”')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }))
  await waitFor(() => expect(mocks.publish).toHaveBeenCalled())
  expect(mocks.choose).toHaveBeenCalledWith({
    id: 'chain',
    owner: mocks.chain,
    expectedRevision: 7,
    outcomeId: 'approvals',
    conditionId: 'iris',
    choice: 'keep-waiting'
  })
  expect(mocks.set).toHaveBeenCalledWith({ id: 'chain' })

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(mocks.choose).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Keep plan' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  mocks.choose.mockRejectedValueOnce(new Error('Outcome revision conflict.'))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }))
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Outcome revision conflict.'
  )
  expect(mocks.choose).toHaveBeenLastCalledWith(expect.objectContaining({ choice: 'cancel' }))
})

it('says plainly when nobody can check a wait', () => {
  const chain = plan()
  chain.outcomeSet!.outcomes[1]!.waits![1] = {
    conditionId: 'iris',
    status: 'unavailable',
    checkedAt: NOW,
    reason: 'omnios is unreachable.'
  }
  mocks.chain = chain
  render(<SessionWaits session={session} visible />)
  expect(screen.getByText('Follow-up not scheduled: omnios is unreachable.')).toBeTruthy()
})
