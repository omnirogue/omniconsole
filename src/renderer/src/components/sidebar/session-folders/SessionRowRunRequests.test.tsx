// @vitest-environment happy-dom
/**
 * A request is only useful where the person can act on it: the row's details print every ask in
 * full with the direct way to meet it, through the same doors as the line under UP NEXT.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { HumanAttentionRequest } from '../../../../../shared/session-human-attention'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  doors: { openConversation: vi.fn(), reviewOutcome: vi.fn(), focusComposer: vi.fn() },
  openDoneWhenList: vi.fn()
}))
vi.mock('@/components/next-action/up-next-attention-actions', () => ({
  runUpNextAttentionAction: mocks.run,
  upNextAttentionDoors: () => mocks.doors
}))
vi.mock('@/components/next-action/use-done-when-list', () => ({
  openDoneWhenList: mocks.openDoneWhenList
}))
vi.mock('@/components/next-action/UpNextPopover', () => ({
  UpNextPopover: ({
    subject,
    triggerContent
  }: {
    subject: { kind: 'session'; session: SidebarSession }
    triggerContent: string
  }) => (
    <button type="button" data-up-next-for={subject.session.rowKey}>
      {triggerContent}
    </button>
  )
}))

import { SessionRowRunRequests } from './SessionRowRunRequests'

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: 'term:tab-1:pane-1',
  kind: 'terminal',
  label: 'Make a clock',
  workspaceLabel: 'Website',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

function request(
  id: string,
  ask: string,
  action?: HumanAttentionRequest['action']
): HumanAttentionRequest {
  return {
    id,
    kind: 'clarification',
    scope: { outcomeId: 'outcome', outcomeRevision: 1 },
    ask,
    why: `Only you can: ${id}`,
    recipient: { type: 'owner' },
    ...(action ? { action } : {}),
    source: { type: 'agent-prompt', ref: id },
    state: 'open',
    openedAt: 5
  }
}

afterEach(() => {
  cleanup()
  mocks.run.mockReset()
  mocks.openDoneWhenList.mockReset()
})

describe('the requests in a row’s details', () => {
  it('prints every ask in full with its own button, and hands a press to the shared doors', () => {
    const answer = request('att_1', 'Answer Claude’s question: which price list is current?', {
      kind: 'open-conversation',
      label: 'Answer',
      paneKey: 'term:tab-9:pane-1'
    })
    const signIn = request('att_2', 'Sign back in as the company this work was started under.', {
      kind: 'sign-in',
      label: 'Sign in'
    })
    render(<SessionRowRunRequests requests={[answer, signIn]} session={session} chainId="chain" />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('data-session-request'))).toEqual([
      'att_1',
      'att_2'
    ])
    expect(items[0]!.textContent).toContain(answer.ask)
    expect(items[0]!.getAttribute('title')).toBe(answer.why)
    expect(items[1]!.textContent).toContain(signIn.ask)
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
      answer,
      { ownPaneKey: session.paneKey, chainId: 'chain' },
      mocks.doors
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(mocks.run).toHaveBeenLastCalledWith(
      signIn,
      { ownPaneKey: session.paneKey, chainId: 'chain' },
      mocks.doors
    )
  })

  it('opens this conversation’s Up next for a decision, with the checklist showing for a review', () => {
    const decide = request('att_3', 'Decide what happens to 2 open review findings.', {
      kind: 'open-up-next',
      label: 'Decide'
    })
    const review = request('att_4', 'Review the landing page.', {
      kind: 'review-outcome',
      label: 'Review',
      conditionId: 'c1'
    })
    render(<SessionRowRunRequests requests={[decide, review]} session={session} chainId="chain" />)
    const decideButton = screen.getByRole('button', { name: 'Decide' })
    expect(decideButton.getAttribute('data-up-next-for')).toBe('row-1')
    fireEvent.click(decideButton)
    expect(mocks.openDoneWhenList).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(mocks.openDoneWhenList).toHaveBeenCalledExactlyOnceWith('chain')
    // Up next is the door for both; neither goes through the conversation opener.
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('prints an ask that names no door without a button, and nothing without requests', () => {
    const { container, rerender } = render(
      <SessionRowRunRequests
        requests={[request('att_5', 'Restore the signed company.')]}
        session={session}
        chainId="chain"
      />
    )
    expect(container.textContent).toBe('Restore the signed company.')
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<SessionRowRunRequests requests={[]} session={session} chainId="chain" />)
    expect(container.innerHTML).toBe('')
  })
})
