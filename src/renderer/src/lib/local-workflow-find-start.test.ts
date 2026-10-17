import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { localWorkflowAnchorSchema } from '../../../shared/local-workflow-session-schema'
import { startLocalWorkflowFindConversation } from './local-workflow-find-start'

const conversation = vi.hoisted(() => ({
  createLocalWorkflowConversation: vi.fn<
    (worktreeId: string, kind: string, options: unknown) => string
  >(() => 'find-tab'),
  persistLocalWorkflowConversationAnchor: vi.fn(async () => undefined),
  titleLocalWorkflowConversation: vi.fn(),
  updateLocalWorkflowConversation: vi.fn()
}))
const rpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('./local-workflow-conversation', () => conversation)
vi.mock('@/runtime/runtime-rpc-client', () => rpc)
const closeTab = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ tabsByWorktree: {} as Record<string, TerminalTab[]> }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ ...state, settings: { reviewRubrics: [] }, closeTab }) }
}))

const TEAM = [
  { id: 'claude', agent: 'claude', accountId: 'a' },
  { id: 'codex', agent: 'codex', accountId: 'b' }
]

function host(start: unknown, setup: Record<string, unknown> = {}) {
  rpc.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
    method === 'localWorkflow.setup' ? { graphTeam: TEAM, maxConcurrency: 4, ...setup } : start
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  state.tabsByWorktree = {}
  vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
})

describe('startLocalWorkflowFindConversation', () => {
  it('opens a background conversation and starts Find the best in it, as Start does', async () => {
    host({ executionId: 'run-1' })
    await expect(
      startLocalWorkflowFindConversation('wt-1', { prompt: 'Name the bakery', keep: 20 })
    ).resolves.toEqual({ conversationId: 'find-tab', executionId: 'run-1' })
    expect(conversation.createLocalWorkflowConversation).toHaveBeenCalledWith('wt-1', 'find', {
      background: true
    })
    const [, method, params] = rpc.callRuntimeRpc.mock.calls[1]!
    expect(method).toBe('localWorkflow.start')
    const { draft } = params as { draft: LocalWorkflowDraft }
    expect(params).toMatchObject({
      worktree: 'id:wt-1',
      conversationId: 'find-tab',
      preset: 'council',
      requestId: 'request-1'
    })
    expect(draft.prompt).toBe('Name the bakery')
    expect(draft.graph!.spec.find).toMatchObject({ keep: 20 })
    expect(draft.graph!.team).toEqual(TEAM)
    // The start request is on the anchor before the host is asked, as a Start from the app.
    expect(conversation.persistLocalWorkflowConversationAnchor).toHaveBeenCalledTimes(3)
    expect(conversation.updateLocalWorkflowConversation).toHaveBeenLastCalledWith(
      'wt-1',
      'find-tab',
      { executionId: 'run-1', startRequest: undefined }
    )
    expect(conversation.titleLocalWorkflowConversation).toHaveBeenCalledWith(
      'find-tab',
      'Name the bakery'
    )
  })

  it('says why it could not start, and leaves no empty conversation behind', async () => {
    await expect(
      startLocalWorkflowFindConversation('wt-1', { prompt: 'x', rubric: 'Nope' })
    ).rejects.toThrow('No rubric is named "Nope"')
    expect(conversation.createLocalWorkflowConversation).not.toHaveBeenCalled()
    host({ executionId: 'run-1' }, { unavailableReason: 'Workflows are off here.' })
    await expect(startLocalWorkflowFindConversation('wt-1', { prompt: 'x' })).rejects.toThrow(
      'Workflows are off here.'
    )
    expect(rpc.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith('find-tab')
    host({ rejected: true, reason: 'Too many calls.' })
    await expect(startLocalWorkflowFindConversation('wt-1', { prompt: 'x' })).rejects.toThrow(
      'Too many calls.'
    )
    expect(conversation.updateLocalWorkflowConversation).toHaveBeenLastCalledWith(
      'wt-1',
      'find-tab',
      { startRequest: undefined }
    )
  })

  it('reuses a persisted launch after a lost reply and refuses a changed request', async () => {
    const operationId = '3f9a1c2e-0000-4000-8000-000000000001'
    const request = { prompt: 'Name the bakery', operationId, origin: 'benchmark' as const }
    host({ executionId: 'run-1' })
    await startLocalWorkflowFindConversation('wt-1', request)
    const options = conversation.createLocalWorkflowConversation.mock.calls.at(-1)![2] as {
      launch: { operationId: string; origin: 'benchmark'; request: string }
    }
    const [, , patch] = conversation.updateLocalWorkflowConversation.mock.calls.find(
      (call) => !!(call[2] as { startRequest?: unknown }).startRequest
    )!
    const workflow = localWorkflowAnchorSchema.parse({
      preset: 'council',
      prompt: request.prompt,
      launch: options.launch,
      startRequest: (patch as { startRequest: unknown }).startRequest
    })
    state.tabsByWorktree = {
      'wt-1': [
        {
          id: `workflow-${operationId}`,
          worktreeId: 'wt-1',
          localWorkflow: workflow
        } as TerminalTab
      ]
    }
    vi.clearAllMocks()
    host({ executionId: 'run-1' })
    const first = startLocalWorkflowFindConversation('wt-1', request)
    const duplicate = startLocalWorkflowFindConversation('wt-1', request)
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { conversationId: `workflow-${operationId}`, executionId: 'run-1' },
      { conversationId: `workflow-${operationId}`, executionId: 'run-1' }
    ])
    expect(conversation.createLocalWorkflowConversation).not.toHaveBeenCalled()
    expect(rpc.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(rpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'localWorkflow.start',
      expect.objectContaining({ requestId: operationId })
    )
    await expect(
      startLocalWorkflowFindConversation('wt-1', { ...request, prompt: 'A different task' })
    ).rejects.toThrow('already belongs to another request')
  })

  it('keeps a persisted replay anchor when its models are no longer available', async () => {
    const operationId = '3f9a1c2e-0000-4000-8000-000000000002'
    const request = { prompt: 'Name the bakery', operationId }
    host({ executionId: 'run-1' })
    await startLocalWorkflowFindConversation('wt-1', request)
    const options = conversation.createLocalWorkflowConversation.mock.calls.at(-1)![2] as {
      launch: { operationId: string; origin: 'cli'; request: string }
    }
    // The first anchor was persisted before setup; a restart can restore only that anchor.
    const tab = {
      id: `workflow-${operationId}`,
      worktreeId: 'wt-1',
      localWorkflow: localWorkflowAnchorSchema.parse({
        preset: 'council',
        prompt: request.prompt,
        launch: options.launch
      })
    } as TerminalTab
    state.tabsByWorktree = { 'wt-1': [tab] }
    vi.clearAllMocks()
    host({ executionId: 'run-1' }, { unavailableReason: 'Workflows are off here.' })
    await expect(startLocalWorkflowFindConversation('wt-1', request)).rejects.toThrow(
      'Workflows are off here.'
    )
    expect(closeTab).not.toHaveBeenCalled()
    expect(conversation.createLocalWorkflowConversation).not.toHaveBeenCalled()
    expect(state.tabsByWorktree['wt-1']).toEqual([tab])
    expect(rpc.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })
})
