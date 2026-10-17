import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import { startLocalWorkflowRunConversation } from './local-workflow-graph-start'

const conversation = vi.hoisted(() => ({
  createLocalWorkflowConversation: vi.fn(() => 'run-tab'),
  persistLocalWorkflowConversationAnchor: vi.fn(async () => undefined),
  titleLocalWorkflowConversation: vi.fn(),
  updateLocalWorkflowConversation: vi.fn()
}))
const rpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('./local-workflow-conversation', () => conversation)
vi.mock('@/runtime/runtime-rpc-client', () => rpc)
const closeTab = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { reviewRubrics: [] }, closeTab }) }
}))

const TEAM = [
  { id: 'claude', agent: 'claude', accountId: 'a' },
  { id: 'codex', agent: 'codex', accountId: 'b' },
  { id: 'grok', agent: 'grok', accountId: 'c' }
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
  rpc.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
    method === 'localWorkflow.setup'
      ? { graphTeam: TEAM, maxConcurrency: 4 }
      : { executionId: 'run-1' }
  )
})

describe('startLocalWorkflowRunConversation', () => {
  it('carries focused quick Discover through the renderer into the strict Start draft', async () => {
    await startLocalWorkflowRunConversation('wt-1', {
      template: 'discover',
      prompt: 'Check evidence',
      depth: 'quick',
      focusFinding: 'parent:2'
    })
    const start = rpc.callRuntimeRpc.mock.calls.find((call) => call[1] === 'localWorkflow.start')
    expect(start?.[2]).toMatchObject({ draft: { focusFinding: 'parent:2' } })
  })

  it('opens the template as its own kind and starts it with only the named families', async () => {
    await expect(
      startLocalWorkflowRunConversation('wt-1', {
        template: 'discover',
        prompt: 'Find bugs',
        routes: ['claude', 'codex']
      })
    ).resolves.toEqual({ conversationId: 'run-tab', executionId: 'run-1' })
    expect(conversation.createLocalWorkflowConversation).toHaveBeenCalledWith('wt-1', 'discover', {
      background: true
    })
    const [, method, params] = rpc.callRuntimeRpc.mock.calls[1]!
    expect(method).toBe('localWorkflow.start')
    expect(params).toMatchObject({ preset: 'discover', conversationId: 'run-tab' })
    const { draft } = params as { draft: LocalWorkflowDraft }
    expect(draft.graph!.spec.template).toBe('discover')
    expect(draft.graph!.team.map((seat) => seat.agent)).toEqual(['claude', 'codex'])
    expect(draft).not.toHaveProperty('skipEarlierRuns')
  })

  it('starts benchmark and --no-earlier-runs runs without the earlier runs list', async () => {
    const drafts: LocalWorkflowDraft[] = []
    for (const extra of [{ origin: 'benchmark' as const }, { skipEarlierRuns: true as const }]) {
      rpc.callRuntimeRpc.mockClear()
      await startLocalWorkflowRunConversation('wt-1', {
        template: 'discover',
        prompt: 'Find bugs',
        ...extra
      })
      const [, , params] = rpc.callRuntimeRpc.mock.calls[1]!
      drafts.push((params as { draft: LocalWorkflowDraft }).draft)
    }
    expect(drafts.map((draft) => draft.skipEarlierRuns)).toEqual([true, true])
  })

  it('checks an OpenRouter override against the team the host lists, not before', async () => {
    const override = {
      template: 'council' as const,
      prompt: 'x',
      spec: {
        steps: {
          answer: {
            agents: [
              { route: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
              { route: 'claude' }
            ]
          }
        }
      }
    }
    rpc.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'localWorkflow.setup'
        ? { graphTeam: [...TEAM, { id: 'openrouter', agent: 'openrouter', accountId: 'd' }] }
        : { executionId: 'run-1' }
    )
    await expect(startLocalWorkflowRunConversation('wt-1', override)).resolves.toEqual({
      conversationId: 'run-tab',
      executionId: 'run-1'
    })
    const [, , params] = rpc.callRuntimeRpc.mock.calls[1]!
    const answer = (params as { draft: LocalWorkflowDraft }).draft.graph!.spec.steps[0]!
    expect(answer.agents.map((agent) => agent.route)).toEqual(['openrouter', 'claude'])
    // Without OpenRouter on this computer, the host's team refuses it and nothing is left open.
    rpc.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'localWorkflow.setup' ? { graphTeam: TEAM } : { executionId: 'run-1' }
    )
    await expect(startLocalWorkflowRunConversation('wt-1', override)).rejects.toThrow(
      'does not make a valid workflow'
    )
    expect(closeTab).toHaveBeenCalledWith('run-tab')
  })

  it('refuses a family this computer cannot run, and leaves no conversation behind', async () => {
    await expect(
      startLocalWorkflowRunConversation('wt-1', {
        template: 'council',
        prompt: 'x',
        routes: ['gemini']
      })
    ).rejects.toThrow('Not set up for workflows on this computer: gemini.')
    expect(closeTab).toHaveBeenCalledWith('run-tab')
    await expect(
      startLocalWorkflowRunConversation('wt-1', {
        template: 'council',
        prompt: 'x',
        spec: { steps: { nope: {} } }
      })
    ).rejects.toThrow('nope')
    expect(conversation.createLocalWorkflowConversation).toHaveBeenCalledTimes(1)
  })
})
