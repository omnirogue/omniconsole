// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  toggleAttentionPage: vi.fn(),
  snapshot: null as unknown
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))
vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => mocks.snapshot
}))
import AttentionSidebarEntry from './AttentionSidebarEntry'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { activeView: 'terminal', toggleAttentionPage: mocks.toggleAttentionPage }
  mocks.snapshot = EMPTY_AGENT_PANE_SNAPSHOT
})

afterEach(cleanup)

describe('AttentionSidebarEntry', () => {
  it('toggles the attention view and shows no badge when nothing waits', async () => {
    const user = userEvent.setup()
    render(<AttentionSidebarEntry />)
    const button = screen.getByRole('button', { name: 'Attention' })
    expect(button.getAttribute('data-attention-count')).toBe('0')
    expect(button.getAttribute('aria-current')).toBeNull()
    await user.click(button)
    expect(mocks.toggleAttentionPage).toHaveBeenCalledOnce()
  })

  it('counts panes that need the user and marks the active view', () => {
    mocks.state = { activeView: 'attention', toggleAttentionPage: mocks.toggleAttentionPage }
    mocks.snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, attention: [{}, {}] }
    render(<AttentionSidebarEntry />)
    const button = screen.getByRole('button', { name: /^Attention/ })
    expect(button.getAttribute('aria-current')).toBe('page')
    expect(screen.getByLabelText('2 need you')).toBeTruthy()
  })
})
