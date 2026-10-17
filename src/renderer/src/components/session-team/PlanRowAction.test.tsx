// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationPlanFixture } from '@/lib/conversation-plan-fixture'
import { PlanRowAction } from './PlanRowAction'
import { ViewPlanButton } from './ViewPlanButton'
import { ConversationStateIcon } from '../sidebar/session-folders/ConversationStateIcon'

const { call, negotiate } = vi.hoisted(() => {
  const call = vi.fn(async () => ({
    reference: { shareUrl: 'https://example.test/plan' },
    files: []
  }))
  return { call, negotiate: vi.fn(async () => ({ call })) }
})
vi.mock('@/lib/session-outcome-connection', () => ({
  sessionOutcomeConnection: () => ({ negotiate })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function readyChain() {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attempts = []
  chain.outcomeSet!.outcomes[0]!.conditions = []
  return chain
}

describe('plan row controls', () => {
  it('shows Plan ✓ and routes View Plan and Publish to the negotiated execution host', async () => {
    render(<PlanRowAction chain={readyChain()} />)
    expect(screen.getByText('Plan ✓')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View Plan' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('workPlan.open', { id: 'chain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('workPlan.publish', { id: 'chain' }))
    expect((await screen.findByRole('link', { name: 'Published plan' })).getAttribute('href')).toBe(
      'https://example.test/plan'
    )
  })

  it('hides View Plan until every current-revision condition has a receipt', () => {
    render(<ViewPlanButton chain={conversationPlanFixture()} />)
    expect(screen.queryByRole('button', { name: 'View Plan' })).toBeNull()
  })

  it('keeps history collapsed and loads files from the owner on expansion', async () => {
    render(<PlanRowAction chain={readyChain()} />)
    const button = screen.getByRole('button', { name: 'Seats and plan history' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Plan v1')).toBeNull()
    fireEvent.click(button)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('sessionChain.outputFiles', {
        workspacePath: '/workspace',
        chainId: 'chain',
        stepId: 's1'
      })
    )
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Plan v1')).toBeTruthy()
  })

  it('prints the full diagnostic of a failed run, and never calls it blocked on the person', () => {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason =
      'No activity was observed for 180s. The worker may have stalled.'
    render(<PlanRowAction chain={chain} />)
    const row = document.querySelector('[data-work-plan-row]')!
    expect(row.getAttribute('data-run-phase')).toBe('failed')
    expect(screen.getByText('Failed · No activity was observed for 180s.')).toBeTruthy()
    expect(document.querySelector('[data-run-detail]')!.textContent).toBe(
      'Plan the work: No activity was observed for 180s. The worker may have stalled.'
    )
    expect(screen.queryByText(/^Blocked/)).toBeNull()
    expect(screen.queryByText(/Needs you/)).toBeNull()
  })

  it.each([
    'needs-you',
    'running',
    'queued',
    'recovering',
    'awaiting',
    'failed',
    'plan-ready',
    'done'
  ] as const)('renders an explicit accessible icon for %s', (state) => {
    render(<ConversationStateIcon state={state} />)
    expect(screen.getByRole('img').getAttribute('data-conversation-state')).toBe(state)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBeTruthy()
  })
})

it('keeps completion bells independent from activity and clears the finished activity glyph', () => {
  const view = render(<ConversationStateIcon state="done" unreadCompletion />)
  expect(
    screen.getByRole('img', { name: 'Unread agent completion' }).querySelector('.lucide-bell')
  ).toBeTruthy()
  view.rerender(<ConversationStateIcon state="done" />)
  expect(screen.getByRole('img').querySelector('svg')).toBeNull()
})

it.each([
  ['needs-you', 'text-agent-question'],
  ['inactive', 'fill-current'],
  ['unverifiable', 'text-muted-foreground']
] as const)('preserves the %s signal on a terminal session', (state, icon) => {
  const { container } = render(<ConversationStateIcon state={state} surface="terminal" />)
  expect(container.querySelector('svg')?.classList.contains(icon)).toBe(true)
  expect(container.querySelector('svg')?.getAttribute('class')).not.toContain('animate-pulse')
})
