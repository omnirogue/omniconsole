// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeChatPlanBlock, type NativeChatPlan } from '../../../../shared/native-chat-plan'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatPlanChecklist, NativeChatSessionPlan } from './NativeChatPlanChecklist'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

afterEach(cleanup)

const plan: NativeChatPlan = {
  entries: [
    { content: 'Read the launch code', status: 'completed' },
    { content: 'Repair session progress', status: 'in_progress' },
    { content: 'Verify the installed app', status: 'pending' }
  ],
  explanation: 'The provider is reporting these steps.'
}

function planMessage(id: string, snapshot: NativeChatPlan): NativeChatMessage {
  return {
    id,
    role: 'system',
    source: 'transcript',
    timestamp: null,
    blocks: [nativeChatPlanBlock(snapshot)]
  }
}

describe('agent checklist rendering', () => {
  it('shows compact progress and opens all statuses in one action', () => {
    render(<NativeChatPlanChecklist plan={plan} />)
    const trigger = screen.getByRole('button', { name: /Agent checklist/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('1/3 complete')).toBeTruthy()
    expect(screen.getByText('Current: Repair session progress')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(plan.explanation!)).toBeTruthy()
    const entries = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(entries.map((entry) => entry.textContent)).toEqual([
      'Completed: Read the launch code',
      'In progress: Repair session progress',
      'Pending: Verify the installed app'
    ])
    expect(entries[1].getAttribute('aria-current')).toBe('step')
    expect(entries[0].hasAttribute('aria-current')).toBe(false)

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('updates the checklist as new journal snapshots arrive and clears it explicitly', () => {
    const first = planMessage('initial', plan)
    const view = render(<NativeChatSessionPlan messages={[first]} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent checklist/ }))

    const updated = planMessage('update', {
      entries: plan.entries.map((entry) => ({ ...entry, status: 'completed' as const }))
    })
    view.rerender(<NativeChatSessionPlan messages={[first, updated]} />)
    expect(screen.getByText('3/3 complete')).toBeTruthy()
    expect(screen.getByText('All steps reported complete')).toBeTruthy()
    expect(screen.queryByText('Current: Repair session progress')).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(within(screen.getByRole('list')).getAllByText('Completed:')).toHaveLength(3)

    view.rerender(
      <NativeChatSessionPlan messages={[first, updated, planMessage('clear', { entries: [] })]} />
    )
    expect(view.container.innerHTML).toBe('')
  })

  it('describes an unstarted step as next and does not invent current progress', () => {
    render(
      <NativeChatPlanChecklist
        plan={{ entries: [{ content: 'Inspect the session', status: 'pending' }] }}
      />
    )
    expect(screen.getByText('0/1 complete')).toBeTruthy()
    expect(screen.getByText('Next: Inspect the session')).toBeTruthy()
    expect(screen.queryByText(/Current:/)).toBeNull()
  })

  it('does not reserve space for a session with no plan', () => {
    const view = render(<NativeChatSessionPlan messages={[]} />)
    expect(view.container.innerHTML).toBe('')
  })
})
