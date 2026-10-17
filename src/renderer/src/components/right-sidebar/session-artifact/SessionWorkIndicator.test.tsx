// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

import { SessionWorkIndicator } from './SessionWorkIndicator'
import { useSessionPanelViewRequest } from './session-panel-view-request'
import { useSessionWorkView } from './session-work-view-store'

beforeEach(() => {
  useSessionPanelViewRequest.setState({ view: null, revision: 0 })
  useSessionWorkView.setState({ pages: 0, plans: 0 })
})
afterEach(() => cleanup())

describe('SessionWorkIndicator', () => {
  it('stays out of sight when the session has no plan or page', () => {
    const { container } = render(<SessionWorkIndicator />)
    expect(container.innerHTML).toBe('')
  })

  it('names what is there and opens Session work on it only when clicked', () => {
    useSessionWorkView.setState({ pages: 0, plans: 1 })
    const { rerender } = render(<SessionWorkIndicator />)
    expect(screen.getByRole('button').textContent).toBe('Plan')
    expect(useSessionPanelViewRequest.getState().revision).toBe(0)
    fireEvent.click(screen.getByRole('button'))
    expect(useSessionPanelViewRequest.getState()).toMatchObject({ view: 'plan', revision: 1 })

    useSessionWorkView.setState({ pages: 2, plans: 1 })
    rerender(<SessionWorkIndicator />)
    expect(screen.getByRole('button').textContent).toBe('Plan · OmniOS')
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Open this session’s work: Plan · OmniOS'
    )
    fireEvent.click(screen.getByRole('button'))
    expect(useSessionPanelViewRequest.getState().view).toBe('omnios')
  })
})
