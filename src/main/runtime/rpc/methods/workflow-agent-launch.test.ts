import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowGraphDraft } from '../../../../shared/local-workflow-draft'
import { LOCAL_WORKFLOW_METHODS } from '../../../../shared/local-workflow-rpc'
import { BUILD_REVIEW_RPC } from '../../../../shared/build-review-pipeline'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcAnyMethod, RpcContext } from '../core'
import { BUILD_REVIEW_METHODS } from './build-review'
import { LOCAL_WORKFLOW_RPC_METHODS } from './local-workflow'

const hostStart = vi.hoisted(() => vi.fn())
const reviewStart = vi.hoisted(() => vi.fn())
vi.mock('../../workflow-script/local-workflow-runtime-host', () => ({
  getLocalWorkflowHost: async () => ({ start: hostStart })
}))
vi.mock('../../build-review/build-review-service-registry', () => ({
  getBuildReviewService: () => ({ start: reviewStart })
}))

const WORDS = 'make it so we can launch the workflows on other computers'
const startLocalWorkflowFind = vi.fn(async () => ({
  worktreeId: 'w',
  conversationId: 'c',
  executionId: 'e'
}))
const runtime = { startLocalWorkflowFind } as unknown as OrcaRuntimeService
/** The CLI inside an agent session sends its session's evidence (ORCA_TERMINAL_HANDLE, …). */
const AGENT: RpcContext = {
  runtime,
  orchestrationCompatibilityEvidence: { terminalHandle: 'term_agent' }
} as RpcContext
const PERSON: RpcContext = { runtime } as RpcContext

function method(methods: RpcAnyMethod[], name: string) {
  const target = methods.find((entry) => entry.name === name)
  if (!target || !('handler' in target) || !target.params) {
    throw new Error(`Missing method ${name}`)
  }
  // Async, so a handler that throws synchronously reads as a refusal like the others.
  return async (params: unknown, context: RpcContext) =>
    (target.handler as (params: unknown, context: RpcContext) => Promise<unknown>)(
      target.params!.parse(params),
      context
    )
}

const run = method(LOCAL_WORKFLOW_RPC_METHODS, LOCAL_WORKFLOW_METHODS.run)
const start = method(LOCAL_WORKFLOW_RPC_METHODS, LOCAL_WORKFLOW_METHODS.start)
const review = method(BUILD_REVIEW_METHODS, BUILD_REVIEW_RPC.start)
const ask = (change: Record<string, unknown> = {}) => ({
  worktree: 'id:w',
  request: { template: 'council', prompt: 'Which cache?', runsOn: 'fleet', ...change }
})

beforeEach(() => {
  startLocalWorkflowFind.mockClear()
  hostStart.mockReset().mockResolvedValue({ executionId: 'e' })
  reviewStart.mockReset().mockReturnValue({ id: 'brp_1' })
})

describe('an agent starting a workflow for a person', () => {
  it('is refused without both the person and their words', async () => {
    const reason =
      'An agent starts a workflow only when a person asks: give --requested-by "<person>" and --request "<their words>".'
    await expect(run(ask(), AGENT)).rejects.toThrow(reason)
    await expect(run(ask({ requestedBy: 'Sal' }), AGENT)).rejects.toThrow(reason)
    expect(startLocalWorkflowFind).not.toHaveBeenCalled()
  })

  it('is accepted with both, which travel with the request to the window', async () => {
    await run(ask({ requestedBy: 'Sal', request: WORDS, host: 'mw0004' }), AGENT)
    expect(startLocalWorkflowFind).toHaveBeenCalledWith(
      'id:w',
      expect.objectContaining({ requestedBy: 'Sal', request: WORDS, host: 'mw0004' })
    )
  })

  it('never forces a busy host, even when a person asked', async () => {
    await expect(
      run(ask({ requestedBy: 'Sal', request: WORDS, host: 'mw0002', forceHost: 'urgent' }), AGENT)
    ).rejects.toThrow('Only a person can force a busy host; an agent cannot use --force-host.')
  })

  it('may start only the workflows marked agent-launchable', async () => {
    await expect(
      run(ask({ template: 'improve', requestedBy: 'Sal', request: WORDS }), AGENT)
    ).rejects.toThrow('An agent cannot start improve workflows; a person starts them from the app.')
    await run(ask({ template: 'discover', requestedBy: 'Sal', request: WORDS }), AGENT)
    expect(startLocalWorkflowFind).toHaveBeenCalledTimes(1)
  })

  it('leaves a person free of the flags, and free to force a named host', async () => {
    await run(ask({ template: 'improve', host: 'mw0002', forceHost: 'urgent' }), PERSON)
    expect(startLocalWorkflowFind).toHaveBeenCalledTimes(1)
  })

  it('applies the same rule to a direct Start', async () => {
    const draft = createLocalWorkflowGraphDraft({
      prompt: 'Which cache?',
      graph: {
        spec: workflowTemplate('council', ['claude']),
        team: [{ id: 'seat-1', agent: 'claude', accountId: 'a' }]
      }
    })
    const request = {
      worktree: 'id:w',
      conversationId: 'c',
      preset: 'council',
      requestId: '00000000-0000-4000-8000-000000000001',
      draft
    }
    expect(await start(request, AGENT)).toEqual({
      rejected: true,
      reason:
        'An agent starts a workflow only when a person asks: give --requested-by "<person>" and --request "<their words>".'
    })
    expect(hostStart).not.toHaveBeenCalled()
    await start({ ...request, draft: { ...draft, requestedBy: 'Sal', request: WORDS } }, AGENT)
    expect(hostStart).toHaveBeenCalledTimes(1)
    await start(request, PERSON)
    expect(hostStart).toHaveBeenCalledTimes(2)
  })

  it('lets an agent start Build + Review for a person, never forcing its host', async () => {
    const base = { worktree: 'id:w', objective: 'Build the page' }
    await expect(review(base, AGENT)).rejects.toThrow(/only when a person asks/)
    await expect(
      review(
        { ...base, requestedBy: 'Sal', request: WORDS, runsOnHost: 'mw0003', forceHost: 'x' },
        AGENT
      )
    ).rejects.toThrow('Only a person can force a busy host')
    await review({ ...base, requestedBy: 'Sal', request: WORDS }, AGENT)
    expect(reviewStart).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: 'Sal', request: WORDS })
    )
  })
})
