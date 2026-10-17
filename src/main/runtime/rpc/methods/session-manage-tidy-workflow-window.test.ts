import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionFolderRelayRequest,
  SessionFolderRendererRequestPayload
} from '../../../../shared/session-folder-cli'
import type { SessionTidyResult } from '../../../../shared/session-manage-types'
import type { WorkflowRunState } from '../../../../shared/session-workflow-anchor'
import type { RpcContext } from '../core'

/**
 * End to end (C6 / A6): `omni session tidy --apply` and `--delete --apply` on a finished
 * pane-less workflow, through the real plan and re-check, the real `mutateSessionFolders` and its
 * delete re-check, the organization log, and the window's real request bridge — its row lookup,
 * archive and tab close. Stood in for: the controller's run record, the tab's own close and
 * storage the window cannot reach here.
 *
 * Why the window's modules are imported by computed path: they compile in the renderer project,
 * this file in the node project; tsc must not resolve one project's aliases from the other.
 */
const state = vi.hoisted(() => ({
  renderer: '../../../../renderer/src',
  dir: '',
  runs: new Map<string, WorkflowRunState>(),
  controllerCalls: [] as string[],
  closed: [] as { tabId: string; options: unknown }[],
  handler: null as ((payload: SessionFolderRendererRequestPayload) => void) | null,
  replies: new Map<string, (reply: { ok: boolean; result?: unknown; error?: string }) => void>()
}))

// Why: no review or Question waits on these sessions; answer-wait.test.ts covers the reads.
vi.mock('../../../answer-delivery/answer-wait', () => ({
  answerWaitKeeper: () => () => null,
  agentAnswerWaitRefusal: () => null
}))
vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))
vi.mock('./session-manage-support', () => ({
  actorFor: () => ({ kind: 'cli' }),
  recordSessionAction: vi.fn()
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', async () => {
  const { observeSources } = await import('../../../session-manage/session-manage-test-fixtures')
  return { createRuntimeObserveSources: () => observeSources({ resolvePane: () => null }) }
})
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => undefined) }))
vi.mock('@/lib/session-organization-host-settle', () => ({ settleHostOrganization: vi.fn() }))
vi.mock('@/lib/session-organization-ownership', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshSessionOrganizationOwnership: vi.fn()
}))
// The tab's own close: recorded, and the tab leaves the window's store as a close leaves it.
vi.mock('@/components/sidebar/session-folders/session-bulk-delete', async () => {
  const { useAppStore } = (await import(/* @vite-ignore */ `${state.renderer}/store/index`)) as {
    useAppStore: AppStoreLike
  }
  return {
    isSessionTabWorking: () => false,
    deleteKeepsPtyIds: () => [],
    closeSessionTabForBulk: vi.fn(async (tabId: string, options: unknown) => {
      state.closed.push({ tabId, options })
      const tabs = useAppStore.getState().tabsByWorktree
      useAppStore.setState({
        tabsByWorktree: Object.fromEntries(
          Object.entries(tabs).map(([id, list]) => [id, list.filter((tab) => tab.id !== tabId)])
        )
      })
      return 'closed' as const
    })
  }
})

vi.stubGlobal('window', {
  api: {
    ui: {
      onRequestSessionFolders: (
        handler: (payload: SessionFolderRendererRequestPayload) => void
      ) => {
        state.handler = handler
        return () => {}
      },
      replySessionFolders: (reply: { requestId: string; ok: boolean }) => {
        state.replies.get(reply.requestId)?.(reply)
      }
    }
  }
})

type Loaded = Record<string, unknown>
const load = (path: string): Promise<Loaded> =>
  import(/* @vite-ignore */ `${state.renderer}/${path}`)

const { SESSION_MANAGE_TIDY_METHOD } = await import('./session-manage-tidy-method')
const { setSessionWorkflowRunReaderFactory } =
  await import('../../../session-manage/session-manage-workflow-runtime')
const store = (await load('store/index')) as { useAppStore: AppStoreLike }
const views = (await load('store/session-sidebar-view')) as { useSessionSidebarView: StoreLike }
const folders = (await load('store/session-folders')) as { useSessionFolders: StoreLike }
const fixtures = (await load('lib/sidebar-session-test-fixtures')) as {
  sessionTestSource: () => Record<string, unknown> & { tabsByWorktree: Record<string, unknown[]> }
  SESSION_TEST_WORKTREE: string
}
const bridge = (await load('hooks/ipc-events/session-folder-request-ipc-bridge')) as {
  registerSessionFolderRequestIpcBridge: (unsubs: (() => void)[]) => void
}

type StoreLike = {
  getState: () => Record<string, unknown> & { archived: string[]; view: { deleted?: string[] } }
  setState: (patch: Record<string, unknown>) => void
}
type AppStoreLike = {
  getState: () => { tabsByWorktree: Record<string, { id: string }[]> }
  setState: (patch: Record<string, unknown>) => void
}

let requestCount = 0
/** The runtime's relay to the window: the bridge answers through its real reply channel. */
function requestSessionFolders(request: SessionFolderRelayRequest): Promise<unknown> {
  const requestId = `request-${++requestCount}`
  return new Promise((resolve, reject) => {
    state.replies.set(requestId, (reply) =>
      reply.ok ? resolve(reply.result) : reject(new Error(reply.error))
    )
    state.handler!({ requestId, request })
  })
}

const context = {
  runtime: {
    getRuntimeId: () => 'runtime-1',
    getArtifactApiOrigin: () => null,
    listSessionChains: () => [],
    listBackgroundRuntimeOwnedTerminals: () => null,
    requestSessionFolders
  }
} as unknown as RpcContext

function workflowTab(id: string, executionId: string) {
  return {
    id,
    worktreeId: fixtures.SESSION_TEST_WORKTREE,
    ptyId: null,
    title: `Council ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 10,
    localWorkflow: { preset: 'council', prompt: 'Which cache?', executionId }
  }
}

/** Two finished Council conversations, each a tab with no pane; the window saw them finish. */
function seedWindow(): void {
  const source = fixtures.sessionTestSource()
  const tabs = [workflowTab('tab-archive', 'execution-a'), workflowTab('tab-delete', 'execution-d')]
  const finished = (tabId: string, executionId: string) => ({
    conversationId: tabId,
    executionId,
    preset: 'council',
    state: 'completed',
    running: 0,
    completed: 4,
    total: 4
  })
  store.useAppStore.setState({
    ...source,
    tabsByWorktree: { [fixtures.SESSION_TEST_WORKTREE]: tabs },
    localWorkflowStatusByTabId: {
      'tab-archive': finished('tab-archive', 'execution-a'),
      'tab-delete': finished('tab-delete', 'execution-d')
    },
    localWorkflowHydrationByTabId: {},
    workspaceSessionReady: true
  })
  views.useSessionSidebarView.setState({
    loaded: true,
    view: { ...views.useSessionSidebarView.getState().view, deleted: [] },
    archived: []
  })
  folders.useSessionFolders.setState({
    loaded: true,
    metadata: { version: 1, folders: [], membership: {} }
  })
}

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'tidy-workflow-window-'))
  bridge.registerSessionFolderRequestIpcBridge([])
  setSessionWorkflowRunReaderFactory(() => async (_row, ref) => {
    state.controllerCalls.push(`read ${ref.runId}`)
    return { status: state.runs.get(ref.runId) ?? 'missing' }
  })
})

afterAll(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

beforeEach(() => {
  seedWindow()
  state.runs = new Map([
    ['execution-a', 'done'],
    ['execution-d', 'done']
  ])
  state.controllerCalls = []
  state.closed = []
})

const rowKey = (tabId: string) => JSON.stringify(['local', fixtures.SESSION_TEST_WORKTREE, tabId])

describe('session tidy on finished pane-less workflows, main to window', () => {
  it('archives one with ordinary tidy --apply: the row is archived, the tab stays', async () => {
    state.runs.set('execution-d', 'running')
    const result = await run({ apply: true, request: 'clean up the sessions' })

    expect(result.applied).toEqual({ archived: 1, skipped: 0, failed: 0 })
    expect(views.useSessionSidebarView.getState().archived).toEqual([rowKey('tab-archive')])
    expect(state.closed).toEqual([])
    expect(tabIds()).toEqual(['tab-archive', 'tab-delete'])
    // Run history kept and nothing cancelled: the controller was only ever read.
    expect(state.controllerCalls.every((call) => call.startsWith('read '))).toBe(true)
  })

  it('closes another with tidy --delete --apply, without --unverified', async () => {
    state.runs.set('execution-a', 'running')
    const result = await run({ delete: true, apply: true, request: 'delete finished sessions' })

    expect(result.applied).toEqual({ archived: 0, deleted: 1, skipped: 0, failed: 0 })
    expect(state.closed).toEqual([
      { tabId: 'tab-delete', options: { captureRecentlyClosed: true, endProcess: true } }
    ])
    expect(tabIds()).toEqual(['tab-archive'])
    expect(views.useSessionSidebarView.getState().view.deleted).toContain(rowKey('tab-delete'))
    expect(state.controllerCalls.every((call) => call.startsWith('read '))).toBe(true)
  })

  it('keeps an anchor whose run the delete re-check finds active again', async () => {
    state.runs.set('execution-a', 'running')
    // The plan, the tidy re-check and main's delete re-check each read the controller.
    let reads = 0
    const restore = setSessionWorkflowRunReaderFactory(() => async (_row, ref) => {
      state.controllerCalls.push(`read ${ref.runId}`)
      if (ref.runId === 'execution-d') {
        reads += 1
        return { status: reads >= 3 ? 'running' : 'done' }
      }
      return { status: state.runs.get(ref.runId) ?? 'missing' }
    })
    const result = await run({
      delete: true,
      apply: true,
      request: 'delete finished sessions'
    }).finally(restore)

    expect(result.applied).toMatchObject({ deleted: 0, failed: 1 })
    expect(result.rows.find((row) => row.tabId === 'tab-delete')?.outcomeReason).toContain(
      'still running'
    )
    expect(state.closed).toEqual([])
    expect(tabIds()).toEqual(['tab-archive', 'tab-delete'])
  })
})

function run(params: Record<string, unknown>): Promise<SessionTidyResult> {
  return SESSION_MANAGE_TIDY_METHOD.handler(params, context) as Promise<SessionTidyResult>
}

function tabIds(): string[] {
  return (store.useAppStore.getState().tabsByWorktree[fixtures.SESSION_TEST_WORKTREE] ?? []).map(
    (tab) => tab.id
  )
}
