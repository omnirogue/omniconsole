// @vitest-environment happy-dom
/**
 * The bulk "send to a person" popover is `w-max`, under which nothing inside the composer can
 * truncate: one long nowrap summary set the popover's width up to the window's. The session
 * composer therefore gets a definite width of its own; the fleet-dispatch branch keeps w-max.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SessionBulkNextStep, type SessionBulkItem } from './SessionBulkNextStep'

vi.mock('@/components/next-action/UpNextSubject', () => ({
  UpNextSubject: () => <div data-up-next-subject />
}))
vi.mock('./SessionBulkFleetDispatch', () => ({
  SessionBulkFleetDispatch: () => <div data-fleet-dispatch />
}))

afterEach(cleanup)

function item(id: string): SessionBulkItem {
  const session: SidebarSession = {
    rowKey: `row-${id}`,
    sessionKey: `session-${id}`,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${id}`,
    paneKey: `tab-${id}:leaf`,
    kind: 'terminal',
    label: `Session ${id}`,
    workspaceLabel: 'Website',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
  return { key: session.sessionKey!, label: session.label, session }
}

it('gives the session composer a definite width inside the w-max popover', () => {
  render(
    <SessionBulkNextStep dispatch={false} items={[item('a')]} label="Send" onFinished={vi.fn()} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  const step = document.querySelector('[data-session-bulk-next-step="session-a"]')!
  expect(step.textContent).toContain('1 of 1 · Session a')
  const wrapper = step.querySelector('[data-session-bulk-next-step-composer]')!
  expect(wrapper.className).toContain('w-[min(48rem,calc(100vw-1rem))]')
  expect(wrapper.querySelector('[data-up-next-subject]')).toBeTruthy()
  // The popover itself still sizes to its content; only the composer is boxed.
  expect(step.closest('[data-slot="popover-content"]')!.className).toContain('w-max')
})

it('leaves the fleet-dispatch branch unboxed', () => {
  render(
    <SessionBulkNextStep
      dispatch={true}
      items={[item('a')]}
      label="Dispatch"
      onFinished={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
  expect(document.querySelector('[data-fleet-dispatch]')).toBeTruthy()
  expect(document.querySelector('[data-session-bulk-next-step-composer]')).toBeNull()
})
