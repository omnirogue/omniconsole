/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import type { SessionProjectReadResult } from '../../../../shared/session-project-cli'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({}),
    subscribe: () => () => undefined
  })
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => 'acct' }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => 'local'
}))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: () => [] }))
vi.mock('@/components/projects/project-settings-dialog-store', () => ({
  openProjectSettings: vi.fn()
}))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: { getState: () => ({ view: { colors: {} } }) }
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: {
    getState: () => ({
      metadata: {
        version: 1,
        folders: [{ id: 'proj-1', name: 'Acme' }],
        membership: {},
        projects: {
          'proj-1': {
            repos: [{ gitIdentity: 'github.com/acme/web' }],
            company: 'Acme',
            coordinator: { launch: { agent: 'claude', team: true } }
          }
        }
      }
    })
  }
}))
vi.mock('@/lib/session-project-for-pane', () => ({
  sessionProjectForPane: (_state: unknown, paneKey: string) =>
    paneKey === 'tab-1:leaf-1' ? 'proj-1' : null
}))
vi.mock('@/lib/session-folder-cli-list', () => ({
  listSessionFolderEntries: () => [
    {
      id: 'proj-1',
      name: 'Acme',
      path: 'Acme',
      section: 'active',
      parentId: null,
      color: null,
      sessionCount: 0
    }
  ]
}))

const doc: SessionContextAttachment = {
  id: 'omnios:closed-unanswered-replies',
  kind: 'omnios',
  title: 'Closed Unanswered Replies',
  uri: 'https://omnios.example/a/closed-unanswered-replies',
  content: 'Snapshot body',
  capturedAt: Date.UTC(2026, 9, 1, 12)
}

/** A fresh module instance, so each test reads launcher storage again. */
async function load() {
  vi.resetModules()
  const { answerSessionProjectRequest } = await import('./session-project-requests')
  return {
    answerSessionProjectRequest,
    ...(await import('@/lib/launch-session-context')),
    ...(await import('@/lib/session-context-store')),
    /** What session prep and the CLI project launch read through main's resolveLaunch. */
    readProject: (worktreeId?: string) =>
      answerSessionProjectRequest({
        kind: 'readProject',
        folder: 'proj-1',
        ...(worktreeId ? { worktreeId } : {})
      }) as SessionProjectReadResult
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('readProject launcher context', () => {
  it('leaves out one-shot launcher context, which rides on the next + launch only', async () => {
    const context = await load()
    const key = context.launchSessionContextKey('wt-1')
    await context.setSessionContext(key, [doc])

    expect(context.readProject('wt-1').launch).toEqual([])
    expect(context.readProject('wt-1').launch).toEqual([])
    // A read-only resolve never clears it: the next + launch still gets it once.
    expect(context.readLaunchSessionContext('wt-1').items).toEqual([doc])
  })

  it('returns launcher context the person kept for future sessions', async () => {
    const context = await load()
    const key = context.launchSessionContextKey('wt-1')
    await context.setSessionContext(key, [doc])
    context.setLaunchSessionContextPinned(key, true)

    expect(context.readProject('wt-1').launch).toEqual([doc])
    expect(context.readProject('wt-1').launch).toEqual([doc])

    context.setLaunchSessionContextPinned(key, false)
    expect(context.readProject('wt-1').launch).toEqual([])
  })

  it('names no launcher context when no workspace was named', async () => {
    const context = await load()
    const key = context.launchSessionContextKey('wt-1')
    await context.setSessionContext(key, [doc])
    context.setLaunchSessionContextPinned(key, true)

    const read = context.readProject()
    expect(read.project?.folderId).toBe('proj-1')
    expect(read).not.toHaveProperty('launch')
  })
})

describe('dispatch requests', () => {
  it("lists the window's projects for main to count their threads", async () => {
    const { answerSessionProjectRequest } = await load()
    expect(answerSessionProjectRequest({ kind: 'listProjects' })).toEqual({
      projects: [
        {
          folderId: 'proj-1',
          name: 'Acme',
          path: 'Acme',
          company: 'Acme',
          repos: 1,
          coordinator: { agent: 'claude', team: true }
        }
      ]
    })
  })

  it('names the project a pane works in, and null for one in none', async () => {
    const { answerSessionProjectRequest } = await load()
    expect(
      answerSessionProjectRequest({ kind: 'projectForPane', paneKey: 'tab-1:leaf-1' })
    ).toEqual({ folderId: 'proj-1' })
    expect(
      answerSessionProjectRequest({ kind: 'projectForPane', paneKey: 'tab-2:leaf-1' })
    ).toEqual({ folderId: null })
  })

  it('keeps a launch’s project context on its tab, already delivered by the launch', async () => {
    const context = await load()
    expect(
      context.answerSessionProjectRequest({
        kind: 'bindLaunchContext',
        tabId: 'tab-9',
        worktreeId: 'wt-1',
        items: [doc]
      })
    ).toEqual({ bound: true })
    const key = context.sessionContextKey({ tabId: 'tab-9', worktreeId: 'wt-1' } as never)
    expect(context.getSessionContext(key)).toEqual([doc])
    // Why: recovery must not send it again to the process the launch already briefed.
    expect(context.consumeSessionContextLaunch('tab-9')).toBe(true)
  })
})
