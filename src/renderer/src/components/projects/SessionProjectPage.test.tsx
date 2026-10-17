// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionProjectThreadGroup } from '@/lib/session-project-thread-groups'
import { emptyProjectSettings } from '../../../../shared/project-settings'
import type { SessionProjectRows } from './use-session-project-rows'

const mocks = vi.hoisted(() => ({
  folderState: {} as Record<string, unknown>,
  appState: { agentStatusByPaneKey: {}, repos: [], worktreesByRepo: {} }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.appState)
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: (selector: (state: unknown) => unknown) => selector(mocks.folderState)
}))
vi.mock('@/lib/session-project-hosted-review', () => ({
  sessionHostedReviewLookup: () => () => false
}))
vi.mock('@/components/work/WorkDispatchComposer', () => ({ WorkDispatchComposer: () => null }))
vi.mock('./SessionProjectContextChips', () => ({ SessionProjectContextChips: () => null }))
vi.mock('./SessionProjectHeader', () => ({ SessionProjectHeader: () => null }))
vi.mock('./SessionProjectLibrary', () => ({ SessionProjectLibrary: () => null }))
vi.mock('./use-project-review-launch', () => ({ useProjectReviewLaunch: () => () => undefined }))
vi.mock('./SessionProjectChatPane', () => ({
  SessionProjectChatPane: ({ thread }: { thread: { row: { session: { rowKey: string } } } }) => (
    <aside data-chat-pane={thread.row.session.rowKey} />
  )
}))
vi.mock('./SessionProjectThreadList', () => ({
  SessionProjectThreadList: ({ groups }: { groups: SessionProjectThreadGroup[] }) => (
    <ul>
      {groups
        .flatMap((group) => group.threads)
        .map(({ row, isCoordinator }) => (
          <li key={row.session.rowKey} data-coordinator={String(isCoordinator)}>
            {row.session.label}
          </li>
        ))}
    </ul>
  )
}))
import { SessionProjectPage } from './SessionProjectPage'

afterEach(cleanup)

it('includes the recorded unfiled coordinator and updates when the binding changes', () => {
  const folder = { id: '00000000-0000-4000-8000-000000000001', name: 'Website' }
  const settings = {
    ...emptyProjectSettings(1),
    coordinator: { launch: { agent: 'codex' as const }, sessionKey: 'provider-key' }
  }
  const data: SessionProjectRows = {
    rows: [
      {
        session: {
          rowKey: 'row',
          sessionKey: 'provider-key',
          worktreeId: 'workspace',
          hostId: 'local',
          tabId: null,
          paneKey: null,
          kind: 'terminal',
          label: 'Project chat',
          workspaceLabel: 'Website',
          agent: 'codex',
          unavailable: false,
          folderKeyMigration: null
        },
        folderId: null,
        attention: null,
        state: 'idle',
        waitingUntil: null,
        archived: true
      }
    ],
    classifications: new Map(),
    workerParentByLeaf: new Map(),
    workerDispatchByLeaf: new Map(),
    chainsByRowKey: new Map(),
    metadata: {
      version: 1,
      folders: [folder],
      membership: {},
      projects: { [folder.id]: settings }
    },
    now: 1
  }
  mocks.folderState = { metadata: data.metadata }
  const view = render(<SessionProjectPage folder={folder} data={data} />)
  expect(screen.getByText('Project chat').getAttribute('data-coordinator')).toBe('true')
  // No open tab to borrow the chat from, so no pane beside the threads.
  expect(document.querySelector('[data-chat-pane]')).toBeNull()

  const open = {
    ...data,
    rows: [{ ...data.rows[0]!, session: { ...data.rows[0]!.session, tabId: 'tab' } }]
  }
  view.rerender(<SessionProjectPage folder={folder} data={open} />)
  expect(document.querySelector('[data-chat-pane]')?.getAttribute('data-chat-pane')).toBe('row')

  mocks.folderState = {
    metadata: {
      ...data.metadata,
      projects: {
        [folder.id]: {
          ...settings,
          coordinator: { ...settings.coordinator, sessionKey: 'other-key' }
        }
      }
    }
  }
  view.rerender(<SessionProjectPage folder={folder} data={data} />)
  expect(screen.queryByText('Project chat')).toBeNull()
})
