import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { OUTCOME_HANDLERS } from './outcome'
import type { SessionChain } from '../../shared/session-chain-types'

const chain: SessionChain = {
  id: 'chain',
  sourcePaneKey: 'pane',
  sourceRowKey: 'row',
  worktreeId: 'folder',
  workspacePath: '/work',
  hostId: 'local',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
}
const prompt = 'Save /output/result.md'
const definition = {
  id: 'result',
  title: 'Result',
  finish: 'complete',
  instructions: prompt,
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: '/output/result.md' }],
  actions: [
    {
      id: 'write',
      instruction: prompt,
      conditionIds: ['file'],
      agent: 'codex',
      authority: 'existing-user-authority'
    }
  ]
}
let directory: string
const response = (result: unknown) => ({ id: 'rpc', ok: true, result })
const setup = () => {
  const call = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
    if (method === 'sessionChain.outcomeCapabilities') {
      return response({ version: 1, durableContinuation: true })
    }
    if (method === 'sessionChain.outcomeSource') {
      return response({ chain, prompt, expectedRevision: 0 })
    }
    if (method === 'sessionChain.commitOutcomes') {
      return response({ chain })
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const context = {
    client: { call },
    flags: new Map(),
    cwd: '/work',
    json: true
  } as unknown as HandlerContext
  return { call, context }
}
const bodyFile = (value: unknown) => {
  const path = join(directory, 'outcomes.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'outcome-cli-'))
  vi.stubEnv('ORCA_PANE_KEY', 'pane')
  vi.stubEnv('ORCA_WORKTREE_ID', 'folder')
  vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'current-claim')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('source outcome CLI', () => {
  it('fetches authoritative context with the existing hook claim envelope', async () => {
    const { call, context } = setup()
    await OUTCOME_HANDLERS['outcome context'](context)
    expect(call).toHaveBeenCalledWith(
      'sessionChain.outcomeSource',
      { paneKey: 'pane', worktreeId: 'folder' },
      expect.objectContaining({
        orchestrationCompatibilityEvidence: expect.objectContaining({
          paneKey: 'pane',
          launchToken: 'current-claim'
        })
      })
    )
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.result.prompt).toBe(prompt)
    expect(output.result.definitionSchema.additionalProperties).toBe(false)
    expect(output.result.submissionSchema.additionalProperties).toBe(false)
    expect(output.result.inferredReviewPlansSupported).toBe(false)
    expect(JSON.stringify(output)).not.toContain('current-claim')
  })
  it('uses host source chain, forces AI, and preserves current dispatch capability on both calls', async () => {
    const { call, context } = setup()
    context.flags.set(
      'body-file',
      bodyFile({ expectedRevision: 0, sourcePrompt: prompt, outcomes: [definition] })
    )
    context.flags.set('dispatch-capability', 'dispatch-secret')
    await OUTCOME_HANDLERS['outcome commit'](context)
    expect(call).toHaveBeenLastCalledWith(
      'sessionChain.commitOutcomes',
      {
        chain,
        expectedRevision: 0,
        expectedSourcePrompt: prompt,
        outcomes: [definition],
        source: 'ai'
      },
      expect.objectContaining({ orchestrationCapability: 'dispatch-secret' })
    )
    expect(call.mock.calls[1][2]).toMatchObject({ orchestrationCapability: 'dispatch-secret' })
  })
  it('leaves save untouched on stale prompt, unknown authority fields, or unavailable owner', async () => {
    const { call, context } = setup()
    context.flags.set(
      'body-file',
      bodyFile({ expectedRevision: 0, sourcePrompt: 'different source', outcomes: [definition] })
    )
    await expect(OUTCOME_HANDLERS['outcome commit'](context)).rejects.toThrow('Source prompt')
    expect(call.mock.calls.some(([method]) => method === 'sessionChain.commitOutcomes')).toBe(false)
    call
      .mockReset()
      .mockResolvedValue(
        response({ version: 1, durableContinuation: false, reason: 'Host unavailable' })
      )
    await expect(OUTCOME_HANDLERS['outcome context'](context)).rejects.toThrow('Host unavailable')
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('never substitutes a focused terminal for missing current source identity', async () => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    const { call, context } = setup()
    await expect(OUTCOME_HANDLERS['outcome context'](context)).rejects.toThrow(
      // f90478376 (#283) renamed the refusal's subject from "terminal" to "conversation"
      // in src/cli/handlers/outcome.ts without updating this expectation.
      'current OmniConsole source conversation'
    )
    expect(call).not.toHaveBeenCalled()
  })
})

it('refuses client-local file reads for a remote CLI bridge', async () => {
  vi.stubEnv('ORCA_CLI_CWD', '/remote/work')
  const { call, context } = setup()
  context.flags.set('body-file', '/remote/work/outcome.json')
  await expect(OUTCOME_HANDLERS['outcome commit'](context)).rejects.toThrow('execution host')
  expect(call).not.toHaveBeenCalled()
})

it.each([true, false])(
  'negotiates chat session disposition support (%s) before committing',
  async (supported) => {
    const { call, context } = setup()
    const sourcePrompt = 'Save this session when done.'
    const sourceOutcome = {
      id: 'source',
      title: 'Finish this session',
      finish: 'complete',
      dependsOn: [],
      conditions: [{ id: 'done', kind: 'session', target: chain.sourcePaneKey }],
      actions: []
    }
    call.mockImplementation(async (method) => {
      if (method === 'sessionChain.outcomeCapabilities') {
        return response({
          version: 1,
          durableContinuation: true,
          ...(supported ? { sessionFinish: 1 } : {})
        })
      }
      if (method === 'sessionChain.outcomeSource') {
        return response({ chain, prompt: sourcePrompt, expectedRevision: 0 })
      }
      return response({ chain })
    })
    context.flags.set(
      'body-file',
      bodyFile({
        expectedRevision: 0,
        sourcePrompt,
        outcomes: [sourceOutcome],
        sessionFinish: { action: 'save' }
      })
    )
    if (supported) {
      await OUTCOME_HANDLERS['outcome commit'](context)
      expect(call).toHaveBeenLastCalledWith(
        'sessionChain.commitOutcomes',
        expect.objectContaining({
          chain,
          source: 'ai',
          expectedSourcePrompt: sourcePrompt,
          sessionFinish: { action: 'save' }
        }),
        expect.any(Object)
      )
    } else {
      await expect(OUTCOME_HANDLERS['outcome commit'](context)).rejects.toThrow(
        'Update the execution host'
      )
      expect(call.mock.calls.some(([method]) => method === 'sessionChain.commitOutcomes')).toBe(
        false
      )
    }
  }
)

it.each([true, false])(
  'negotiates chat review settings with the host: supported=%s',
  async (supported) => {
    const { call, context } = setup()
    const reviewPrompt = 'Have Codex review the finished work.'
    const reviewPlans = [{ id: 'review_group', outcomeId: 'result', actionIds: ['review_action'] }]
    const outcome = {
      ...definition,
      instructions: reviewPrompt,
      conditions: [{ id: 'report', kind: 'report', target: 'review_action' }],
      actions: [
        {
          id: 'review_action',
          instruction: reviewPrompt,
          conditionIds: ['report'],
          agent: 'codex',
          authority: 'existing-user-authority'
        }
      ]
    }
    call.mockImplementation(async (method) => {
      if (method === 'sessionChain.outcomeCapabilities') {
        return response({
          version: 1,
          durableContinuation: true,
          ...(supported ? { inferredReviewPlans: 1 } : {})
        })
      }
      if (method === 'sessionChain.outcomeSource') {
        return response({ chain, prompt: reviewPrompt, expectedRevision: 0 })
      }
      return response({ chain })
    })
    context.flags.set(
      'body-file',
      bodyFile({
        sourcePrompt: reviewPrompt,
        expectedRevision: 0,
        outcomes: [outcome],
        reviewPlans
      })
    )
    if (supported) {
      await OUTCOME_HANDLERS['outcome commit'](context)
      expect(call).toHaveBeenLastCalledWith(
        'sessionChain.commitOutcomes',
        expect.objectContaining({
          chain,
          source: 'ai',
          expectedSourcePrompt: reviewPrompt,
          outcomes: [outcome],
          reviewPlans
        }),
        expect.any(Object)
      )
    } else {
      await expect(OUTCOME_HANDLERS['outcome commit'](context)).rejects.toThrow(
        'Update this execution host'
      )
      expect(call.mock.calls.some(([method]) => method === 'sessionChain.commitOutcomes')).toBe(
        false
      )
    }
  }
)
