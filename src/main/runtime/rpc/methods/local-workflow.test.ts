import { DEFAULT_WORKFLOW_MODEL_TIERS } from '../../../../shared/workflow-model-tiers'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_WORKFLOW_METHODS } from '../../../../shared/local-workflow-rpc'
import {
  createLocalWorkflowDraft,
  createLocalWorkflowGraphDraft
} from '../../../../shared/local-workflow-draft'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { OrcaRuntimeService as RuntimePrototype } from '../../omni-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { isStreamingMethod, type RpcContext, type RpcMethod } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import { LOCAL_WORKFLOW_RPC_METHODS } from './local-workflow'

const opened: { db: OrchestrationDb; path: string }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.db.close()
    await rm(item.path, { recursive: true, force: true })
  }
})

async function fixture(
  options: {
    tab?: 'workflow' | 'ordinary' | 'missing'
    host?: string
    linked?: boolean
  } = {}
) {
  const path = await mkdtemp(join(tmpdir(), 'local-workflow-rpc-'))
  const db = new OrchestrationDb(':memory:')
  opened.push({ db, path })
  const tab =
    options.tab === 'missing'
      ? []
      : [
          {
            id: 'workflow-tab',
            worktreeId: 'workspace-1',
            ptyId: null,
            ...(options.tab === 'ordinary'
              ? {}
              : { localWorkflow: { preset: 'council', prompt: '' } })
          }
        ]
  const runtime = Object.assign(Object.create(RuntimePrototype.prototype), {
    getRuntimeId: () => 'test-runtime',
    getOrchestrationDb: () => db,
    getAgentAccountSettings: () => ({}),
    resolveTerminalWorkspaceLaunchTarget: async () => ({
      scope: { id: 'workspace-1', path, connectionId: null },
      managedWorktree: { id: 'workspace-1', path, displayName: 'Local workspace' }
    }),
    getWorkspaceSessionHostIdForWorktree: () => options.host ?? 'local',
    getHubLinkedWorkspaceItem: () => (options.linked ? { hubTaskId: 'btk_123' } : null),
    getWorkspaceSessionForWorktree: () => ({ tabsByWorktree: { 'workspace-1': tab } })
  }) as OrcaRuntimeService
  return { runtime, db }
}

async function callSetup(runtime: OrcaRuntimeService, context?: Partial<RpcContext>) {
  const method = LOCAL_WORKFLOW_RPC_METHODS.find(
    (entry) => entry.name === LOCAL_WORKFLOW_METHODS.setup
  ) as RpcMethod
  const params = method.params!.parse({
    worktree: 'id:workspace-1',
    conversationId: 'workflow-tab',
    preset: 'council'
  })
  return method.handler(params, { runtime, ...context } as RpcContext)
}

describe('local workflow runtime RPC boundary', () => {
  it('registers every public method and accepts a persisted local workflow tab', async () => {
    const names = new Set(ALL_RPC_METHODS.map((method) => method.name))
    expect(Object.values(LOCAL_WORKFLOW_METHODS).every((name) => names.has(name))).toBe(true)
    const { runtime, db } = await fixture()
    const result = (await callSetup(runtime)) as {
      scopeLabel: string
      defaults: { seats: { agent: string }[] }
      catalog: { agent: string; unavailableReason?: string; models: unknown[] }[]
      unavailableReason?: string
    }
    expect(result.scopeLabel).toBe('Local workspace')
    const routes = ['claude', 'codex', 'grok', 'gemini', 'openrouter', 'ollama']
    const agents = new Set(result.catalog.map((entry) => entry.agent))
    expect([...agents].every((agent) => routes.includes(agent))).toBe(true)
    expect(['claude', 'codex', 'grok'].every((agent) => agents.has(agent))).toBe(true)
    const available = new Set(
      result.catalog
        .filter((entry) => !entry.unavailableReason && entry.models.length)
        .map((entry) => entry.agent)
    )
    expect(result.defaults.seats.map((seat) => seat.agent)).toEqual(
      routes.filter((agent) => !['openrouter', 'ollama'].includes(agent) && available.has(agent))
    )
    if (available.size < 2 || [...available].every((agent) => agent === 'gemini')) {
      expect(result.unavailableReason).toMatch(/at least two of Claude, Codex, Grok or Gemini/)
    } else {
      expect(result.unavailableReason).toBeUndefined()
    }
    expect(
      db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 0 })
  })

  it.each([
    ['fabricated tab', { tab: 'missing' }],
    ['ordinary Model tab', { tab: 'ordinary' }],
    ['remote host', { host: 'ssh:connection-1' }],
    ['card-bound workspace', { linked: true }]
  ] as const)('refuses %s before creating an execution', async (_label, options) => {
    const { runtime, db } = await fixture(options)
    await expect(callSetup(runtime)).rejects.toThrow()
    expect(
      db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 0 })
  })

  it('rejects paired and mobile callers before host initialization', async () => {
    const { runtime, db } = await fixture()
    await expect(callSetup(runtime, { pairedDeviceId: 'device-1' })).rejects.toThrow(
      /desktop runtime/
    )
    await expect(callSetup(runtime, { clientKind: 'mobile' })).rejects.toThrow(/desktop runtime/)
    expect(
      db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 0 })
  })

  it('carries paired identity through the real RPC dispatcher', async () => {
    const { runtime } = await fixture()
    const dispatcher = new RpcDispatcher({ runtime, methods: LOCAL_WORKFLOW_RPC_METHODS })
    const result = await dispatcher.dispatch(
      {
        id: 'paired-setup',
        authToken: 'test-token',
        method: LOCAL_WORKFLOW_METHODS.setup,
        params: { worktree: 'id:workspace-1', conversationId: 'workflow-tab', preset: 'council' }
      },
      { pairedDeviceId: 'device-1', clientKind: 'runtime' }
    )
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/desktop runtime/) }
    })
  })

  it('streams views through a watch method and reads logs through a one-shot method', async () => {
    const watch = LOCAL_WORKFLOW_RPC_METHODS.find(
      (method) => method.name === LOCAL_WORKFLOW_METHODS.watch
    )!
    const readCall = LOCAL_WORKFLOW_RPC_METHODS.find(
      (method) => method.name === LOCAL_WORKFLOW_METHODS.readCall
    )!
    expect(isStreamingMethod(watch)).toBe(true)
    expect(isStreamingMethod(readCall)).toBe(false)
    const address = {
      worktree: 'id:workspace-1',
      conversationId: 'workflow-tab',
      executionId: '00000000-0000-4000-8000-000000000000'
    }
    expect(readCall.params!.safeParse({ ...address, callId: 'answer/seat-1' }).success).toBe(true)
    expect(readCall.params!.safeParse(address).success).toBe(false)
    const { runtime, db } = await fixture()
    const emit = vi.fn()
    if (!isStreamingMethod(watch)) {
      throw new Error('Expected a streaming watch method')
    }
    await expect(
      watch.handler(
        watch.params!.parse(address),
        { runtime, clientKind: 'mobile' } as RpcContext,
        emit
      )
    ).rejects.toThrow(/desktop runtime/)
    await expect(
      watch.handler(watch.params!.parse(address), { runtime } as RpcContext, emit)
    ).rejects.toThrow(/not found/)
    expect(emit).not.toHaveBeenCalled()
    expect(
      db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 0 })
  })

  it('reads a run status for the tab strip as a desktop-only one-shot method', async () => {
    const status = LOCAL_WORKFLOW_RPC_METHODS.find(
      (method) => method.name === LOCAL_WORKFLOW_METHODS.status
    ) as RpcMethod
    expect(isStreamingMethod(status)).toBe(false)
    const address = {
      worktree: 'id:workspace-1',
      conversationId: 'workflow-tab',
      executionId: '00000000-0000-4000-8000-000000000000'
    }
    expect(status.params!.safeParse(address).success).toBe(true)
    expect(status.params!.safeParse({ ...address, executionId: 'not-a-uuid' }).success).toBe(false)
    const { runtime } = await fixture()
    await expect(
      status.handler(status.params!.parse(address), {
        runtime,
        pairedDeviceId: 'device-1'
      } as RpcContext)
    ).rejects.toThrow(/desktop runtime/)
    await expect(
      status.handler(status.params!.parse(address), { runtime } as RpcContext)
    ).rejects.toThrow(/not found/)
  })

  it('accepts current drafts with Gemini members and access, and legacy three-seat drafts', () => {
    const start = LOCAL_WORKFLOW_RPC_METHODS.find(
      (method) => method.name === LOCAL_WORKFLOW_METHODS.start
    )!
    const seats = (['claude', 'codex', 'grok', 'gemini'] as const).map((agent, index) => ({
      id: `seat-${index + 1}`,
      agent,
      accountId: `system:${agent}`
    }))
    const council = createLocalWorkflowDraft('council', 'Which cache should we use?')
    council.seats = seats
    council.council = { memberIds: seats.map((seat) => seat.id) }
    const discover = createLocalWorkflowDraft('discover', 'Find real bugs')
    discover.seats = seats.slice(0, 3)
    discover.discover.finderIds = ['seat-1', 'seat-2']
    discover.discover.focus = ['src/']
    const legacy = { ...createLocalWorkflowDraft('council', 'Old draft'), seats: seats.slice(0, 3) }
    delete legacy.access
    delete legacy.council
    for (const [preset, draft] of [
      ['council', council],
      ['discover', discover],
      ['council', legacy]
    ] as const) {
      expect(
        start.params!.safeParse({
          worktree: 'id:workspace-1',
          conversationId: 'workflow-tab',
          preset,
          requestId: '00000000-0000-4000-8000-000000000001',
          draft
        }).success
      ).toBe(true)
    }
  })

  it('accepts a workflow graph draft with its team, and refuses a seatless draft without one', () => {
    const start = LOCAL_WORKFLOW_RPC_METHODS.find(
      (method) => method.name === LOCAL_WORKFLOW_METHODS.start
    )!
    const request = (draft: unknown) =>
      start.params!.safeParse({
        worktree: 'id:workspace-1',
        conversationId: 'workflow-tab',
        preset: 'council',
        requestId: '00000000-0000-4000-8000-000000000002',
        draft
      })
    const graph = createLocalWorkflowGraphDraft({
      prompt: 'Which cache should we use?',
      graph: {
        spec: workflowTemplate('council', ['claude', 'codex']),
        team: [
          { id: 'claude', agent: 'claude', accountId: 'system:claude' },
          { id: 'codex', agent: 'codex', accountId: 'system:codex' }
        ]
      }
    })
    expect(graph.seats).toEqual([])
    expect(request(graph).success).toBe(true)
    expect(request({ ...graph, graph: undefined }).success).toBe(false)
    expect(request({ ...graph, graph: { ...graph.graph, extra: true } }).success).toBe(false)
  })
})

it('captures native defaults when saving a model preset and keeps explicit OpenRouter ids', () => {
  const saveWorkflowModelPreset = vi.fn(() => [])
  const context = {
    clientId: 'desktop-renderer',
    runtime: { saveWorkflowModelPreset }
  } as unknown as RpcContext
  const method = LOCAL_WORKFLOW_RPC_METHODS.find(
    (entry) => entry.name === LOCAL_WORKFLOW_METHODS.saveModelPreset
  )!
  if (isStreamingMethod(method)) {
    throw new Error('Expected ordinary RPC')
  }
  const input = {
    name: 'Mixed',
    models: [{ route: 'claude' }, { route: 'openrouter', model: 'deepseek/chat' }]
  }
  method.handler(method.params!.parse(input), context)
  expect(saveWorkflowModelPreset).toHaveBeenCalledWith({
    name: 'Mixed',
    models: [
      { route: 'claude', model: 'opus' },
      { route: 'openrouter', model: 'deepseek/chat' }
    ]
  })
})

it('reads tiers for any local caller and saves them only from the person, validated', () => {
  const state = { tiers: DEFAULT_WORKFLOW_MODEL_TIERS, customized: true }
  const readWorkflowModelTiers = vi.fn(() => state)
  const saveWorkflowModelTiers = vi.fn(() => state)
  const runtime = { readWorkflowModelTiers, saveWorkflowModelTiers }
  const method = (name: string) => {
    const found = LOCAL_WORKFLOW_RPC_METHODS.find((entry) => entry.name === name)!
    if (isStreamingMethod(found)) {
      throw new Error('Expected ordinary RPC')
    }
    return found
  }
  const person = { clientId: 'desktop-renderer', runtime } as unknown as RpcContext
  const read = method(LOCAL_WORKFLOW_METHODS.modelTiers)
  expect(read.handler(read.params!.parse({}), person)).toBe(state)
  const save = method(LOCAL_WORKFLOW_METHODS.saveModelTiers)
  const cheap = [{ route: 'ollama', model: 'qwen3:8b' }]
  const tiers = { ...DEFAULT_WORKFLOW_MODEL_TIERS, cheap }
  save.handler(save.params!.parse({ tiers }), person)
  expect(saveWorkflowModelTiers).toHaveBeenCalledWith(tiers)
  save.handler(save.params!.parse({ tiers: null }), person)
  expect(saveWorkflowModelTiers).toHaveBeenLastCalledWith(null)
  expect(save.params!.safeParse({ tiers: { ...tiers, cheap: [] } }).success).toBe(false)
  expect(
    save.params!.safeParse({ tiers: { ...tiers, cheap: [{ route: 'openrouter' }] } }).success
  ).toBe(false)
  // An agent's session may not rewrite what the person's tiers mean.
  const agent = { ...person, orchestrationCapability: {} } as unknown as RpcContext
  expect(() => save.handler(save.params!.parse({ tiers }), agent)).toThrow(
    'requires the authenticated user interface'
  )
})
