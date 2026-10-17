// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useQuietWorkspace } from '@/store/quiet-workspace'
import { QuietWorkspace } from './QuietWorkspace'
vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => ({ attention: [], cards: [{ dotState: 'done', unseen: true }] })
}))
beforeEach(() => useQuietWorkspace.setState({ enabled: false, background: 'beach' }))
afterEach(cleanup)
it('covers a running surface without remounting it or losing an unsent draft', () => {
  const unmount = vi.fn()
  function Session() {
    useEffect(() => unmount, [])
    return <input aria-label="Draft" defaultValue="Keep this requirement" />
  }
  const view = render(
    <QuietWorkspace available>
      <Session />
    </QuietWorkspace>
  )
  const draft = screen.getByLabelText('Draft')
  act(() => useQuietWorkspace.getState().toggle())
  expect(view.container.querySelector('[data-quiet-workspace="beach"]')).not.toBeNull()
  expect(draft.closest('[inert]')).not.toBeNull()
  expect(screen.getByRole('status').textContent).toContain('One session has a result to review')
  fireEvent.click(screen.getByRole('button', { name: /^Plain$/ }))
  expect(view.container.querySelector('[data-quiet-workspace="plain"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show conversation' }))
  expect(screen.getByLabelText('Draft')).toBe(draft)
  expect((draft as HTMLInputElement).value).toBe('Keep this requirement')
  expect(draft.closest('[inert]')).toBeNull()
  expect(unmount).not.toHaveBeenCalled()
})
it('does not cover another page while the personal preference stays enabled', () => {
  useQuietWorkspace.setState({ enabled: true })
  const view = render(
    <QuietWorkspace available={false}>
      <input aria-label="Task" />
    </QuietWorkspace>
  )
  expect(view.container.querySelector('[data-quiet-workspace]')).toBeNull()
  expect(screen.getByLabelText('Task').closest('[inert]')).toBeNull()
})
