// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import NativeChatView from './NativeChatView'

vi.mock('./NativeChatResolvedView', () => ({
  NativeChatResolvedView: ({ sessionId }: { sessionId: string | null }) => (
    <p>Session: {sessionId ?? 'unknown'}</p>
  )
}))
vi.mock('./NativeChatStructuredSession', () => ({ NativeChatStructuredSession: () => null }))
const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('shows the resumed transcript identity only in the pane owning the tab resume claim', () => {
  useAppStore.setState({
    automaticAgentResumeClaimsByTabId: {
      resumed: {
        worktreeId: 'wt',
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'recorded-session' }
      }
    }
  })
  const props = {
    terminalTabId: 'resumed',
    isVisible: true,
    transcriptLive: true,
    targetPtyId: 'pty',
    launchAgent: 'codex' as const
  }
  const view = render(
    <NativeChatView
      worktreeId="workspace"
      {...props}
      paneKey="resumed:original"
      ownsTabWideLaunchDraft
    />
  )
  expect(screen.getByText('Session: recorded-session')).toBeTruthy()
  view.rerender(
    <NativeChatView
      worktreeId="workspace"
      {...props}
      paneKey="resumed:sibling"
      ownsTabWideLaunchDraft={false}
    />
  )
  expect(screen.getByText('Session: unknown')).toBeTruthy()
})
