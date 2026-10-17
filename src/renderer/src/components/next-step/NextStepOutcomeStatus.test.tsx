// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const phase = vi.hoisted(() => ({ agentState: 'working' as string | null, returned: false }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('./use-next-step-session-phase', () => ({
  useNextStepSessionPhaseInput: () => phase
}))
vi.mock('./OutcomeResolutionActions', () => ({
  OutcomeResolutionActions: () => <div data-testid="resolution-actions" />
}))
import { NextStepOutcomeStatus } from './NextStepOutcomeStatus'
afterEach(cleanup)

const session = { paneKey: 'tab:pane', label: 'Work' } as SidebarSession
const chain = {
  id: 'chn',
  outcomeSet: {
    outcomes: [
      {
        id: 'o1',
        title: 'Ship the report',
        conditions: [
          { id: 'c1', kind: 'file', target: '/out/report.md' },
          { id: 'c2', kind: 'review', target: 'reviewer' }
        ],
        evidence: [{ conditionId: 'c1' }]
      }
    ]
  }
} as unknown as SessionChain

it('reads the pane phase and offers nothing to count before an outcome set exists', () => {
  render(
    <NextStepOutcomeStatus
      session={session}
      outcome={{ id: 'o', finish: null, instructions: '', steps: [] }}
      chain={null}
      onChainChanged={() => {}}
      onError={() => {}}
    />
  )
  expect(screen.getByText('Working')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('says n/m verified and expands to the conditions with their markers and the open actions', () => {
  render(
    <NextStepOutcomeStatus
      session={session}
      outcome={{
        id: 'o1',
        finish: null,
        instructions: '',
        steps: [],
        status: 'needs-you',
        needsYouReason: 'Approve the review'
      }}
      chain={chain}
      onChainChanged={() => {}}
      onError={() => {}}
    />
  )
  expect(screen.getByText('Needs you · Approve the review')).toBeTruthy()
  const toggle = screen.getByRole('button', { name: '1/2 verified' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByTestId('resolution-actions')).toBeNull()
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const rows = [...document.querySelectorAll('[data-next-step-condition]')]
  expect(rows.map((row) => row.getAttribute('data-next-step-condition'))).toEqual([
    'verified',
    'pending'
  ])
  expect(rows[0]!.textContent).toContain('Ship the report · File')
  expect(rows[1]!.textContent).toContain('Ship the report · Review')
  expect(screen.getByTestId('resolution-actions')).toBeTruthy()
})

it('prints a blocked outcome as Failed — never "Needs you" — with the raw reason only in the tooltip', () => {
  const stall = 'No activity was observed for 180s after this step was accepted.'
  const blocked = {
    id: 'chn',
    outcomeSet: {
      outcomes: [
        {
          id: 'o1',
          revision: 1,
          title: 'Ship the report',
          status: 'blocked',
          blockedReason: stall,
          conditions: [{ id: 'c1', kind: 'file', target: '/out/report.md' }],
          evidence: []
        }
      ],
      attempts: []
    }
  } as unknown as SessionChain
  render(
    <NextStepOutcomeStatus
      session={session}
      outcome={{ id: 'o1', revision: 1, finish: null, instructions: '', steps: [] }}
      chain={blocked}
      onChainChanged={() => {}}
      onError={() => {}}
    />
  )
  const line = screen.getByText('Failed')
  expect(line.className).toContain('text-destructive')
  expect(line.getAttribute('title')).toBe(stall)
  expect(document.querySelector('[data-next-step-status="failed"]')).toBeTruthy()
  expect(document.body.textContent).not.toContain('Needs you')
  expect(document.body.textContent).not.toContain('No activity was observed')
})
