// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PtySessionWorkRail } from './PtySessionWorkRail'

const mocks = vi.hoisted(() => ({
  switchView: vi.fn(),
  state: {
    settings: { experimentalNativeChat: true },
    unifiedTabsByWorktree: {
      unrelated: [
        { id: 'wrong-owner', entityId: 'terminal', contentType: 'terminal', viewMode: 'terminal' }
      ],
      workspace: [
        { id: 'unified', entityId: 'terminal', contentType: 'terminal', viewMode: 'chat' }
      ]
    },
    tabsByWorktree: { workspace: [{ id: 'terminal', title: 'Shell' }] },
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {}
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.state)
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('./native-chat-runtime-owner', () => ({ selectNativeChatRuntimeEnvironmentId: () => null }))
vi.mock('./use-native-chat-agent-exit', () => ({
  useNativeChatAgentExit: () => ({ record: null, agentExit: null })
}))
vi.mock('./switch-native-chat-view', () => ({ switchNativeChatView: mocks.switchView }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
vi.mock('@/components/sidebar/routines/routine-conversation-state', () => ({
  useRoutineForTab: () => null
}))
vi.mock('@/components/sidebar/routines/RoutineConversationHeader', () => ({
  RoutineConversationHeader: () => null
}))
vi.mock('@/components/next-action/UpNextSubject', () => ({ UpNextSubject: () => null }))
vi.mock('@/components/session-activity/SessionActivityPanel', () => ({
  SessionActivityPanel: () => null
}))
afterEach(cleanup)

it('renders exactly one real escape switch for a restored Chat tab without agent evidence', () => {
  const view = render(
    <TooltipProvider>
      <PtySessionWorkRail
        worktreeId="workspace"
        tabId="terminal"
        paneKey="terminal:leaf"
        agent={null}
        ptyId={null}
        visible
        isChatViewMode
        readTerminalScreen={() => null}
      />
    </TooltipProvider>
  )
  expect(view.container.querySelectorAll('[data-native-chat-switch]')).toHaveLength(1)
  fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }))
  expect(mocks.switchView).toHaveBeenCalledExactlyOnceWith('workspace', 'unified', 'terminal', {
    paneKey: undefined
  })
})
