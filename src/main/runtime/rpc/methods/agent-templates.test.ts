import { describe, expect, it, vi } from 'vitest'
import type { AgentTemplateSettings } from '../../../../shared/agent-templates'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { AGENT_SESSION_METHODS } from './agent-session'
import { AGENT_TEMPLATE_METHODS } from './agent-templates'
import { TERMINAL_METHODS } from './terminal'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function runtimeWith(initial: AgentTemplateSettings | undefined) {
  let stored = initial
  const terminal = { handle: 't', worktreeId: 'w', title: null }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getAgentTemplateSettings: vi.fn(() => stored),
    replaceAgentTemplateSettings: vi.fn((next: AgentTemplateSettings) => {
      stored = next
    }),
    createTerminal: vi.fn(async () => terminal),
    dedupeTerminalCreate: vi.fn(
      async (
        _client: string,
        worktree: string | undefined,
        _mutationId: string | undefined,
        _reconcile: boolean,
        run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
      ) => run(worktree, undefined)
    ),
    createAgentSession: vi.fn(async () => ({ terminal, disposition: 'created' }))
  }
  const dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: [...AGENT_TEMPLATE_METHODS, ...TERMINAL_METHODS, ...AGENT_SESSION_METHODS]
  })
  return { runtime, dispatcher, stored: () => stored }
}

const advertising: AgentTemplateSettings = {
  custom: [
    {
      id: 'advertising',
      name: 'Advertising',
      description: '',
      instructions: '# Advertising\nPause, never scale.'
    }
  ]
}

describe('agentTemplates RPC', () => {
  it('lists resolved templates with digests', async () => {
    const { dispatcher } = runtimeWith(advertising)
    const response = await dispatcher.dispatch(request('agentTemplates.list'))
    expect(response).toMatchObject({ ok: true })
    const templates = (response as { result: { templates: { id: string; digest: string }[] } })
      .result.templates
    expect(templates.map((template) => template.id)).toEqual([
      'default',
      'developer',
      'reviewer',
      'researcher',
      'coordinator',
      'advertising'
    ])
    expect(templates.at(-1)?.digest).toBe('d30fc78b9495')
  })

  it('writes a template through the settings writer and returns its new digest', async () => {
    const { dispatcher, runtime, stored } = runtimeWith(advertising)
    const response = await dispatcher.dispatch(
      request('agentTemplates.set', { id: 'advertising', instructions: '# Advertising\nPause.' })
    )
    expect(response).toMatchObject({
      ok: true,
      result: { template: { id: 'advertising', instructions: '# Advertising\nPause.' } }
    })
    expect(runtime.replaceAgentTemplateSettings).toHaveBeenCalledTimes(1)
    expect(stored()?.custom?.[0]?.instructions).toBe('# Advertising\nPause.')
  })

  it('refuses an invalid edit with invalid_argument and writes nothing', async () => {
    const { dispatcher, runtime } = runtimeWith(advertising)
    const response = await dispatcher.dispatch(
      request('agentTemplates.set', { id: 'default', instructions: 'x' })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.replaceAgentTemplateSettings).not.toHaveBeenCalled()
  })

  it('removes only custom templates', async () => {
    const { dispatcher, stored } = runtimeWith(advertising)
    expect(
      await dispatcher.dispatch(request('agentTemplates.remove', { id: 'developer' }))
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(
      await dispatcher.dispatch(request('agentTemplates.remove', { id: 'advertising' }))
    ).toMatchObject({ ok: true, result: { removed: 'advertising' } })
    expect(stored()).toEqual({})
  })
})

describe('agentTemplateId launch param', () => {
  it('records the resolved template on terminal.create', async () => {
    const { dispatcher, runtime } = runtimeWith(advertising)
    const response = await dispatcher.dispatch(
      request('terminal.create', { worktree: 'id:w', agentTemplateId: 'advertising' })
    )
    expect(response).toMatchObject({ ok: true })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:w',
      expect.objectContaining({
        agentTemplate: { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }
      })
    )
  })

  it('refuses an unknown id before any terminal exists', async () => {
    const { dispatcher, runtime } = runtimeWith(advertising)
    const response = await dispatcher.dispatch(
      request('terminal.create', { worktree: 'id:w', agentTemplateId: 'advertsing' })
    )
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('Unknown agent template "advertsing"')
      }
    })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('records an explicit Default, and nothing when the param is absent', async () => {
    const { dispatcher, runtime } = runtimeWith(advertising)
    await dispatcher.dispatch(
      request('terminal.create', { worktree: 'id:w', agentTemplateId: 'default' })
    )
    await dispatcher.dispatch(request('terminal.create', { worktree: 'id:w' }))
    const calls = runtime.createTerminal.mock.calls as unknown as [string, object][]
    expect(calls[0]![1]).toMatchObject({
      agentTemplate: { id: 'default', name: 'Default', digest: 'e3b0c44298fc' }
    })
    expect(calls[1]![1]).not.toHaveProperty('agentTemplate')
  })

  it('forwards the raw id to createAgentSession, which resolves it after its replay check', async () => {
    const { dispatcher, runtime } = runtimeWith(advertising)
    const response = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        worktree: 'id:w',
        agent: 'claude',
        agentTemplateId: 'developer'
      })
    )
    expect(response).toMatchObject({ ok: true })
    const [sent] = runtime.createAgentSession.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(sent.agentTemplateId).toBe('developer')
  })

  it('replays a reconciled terminal.create even when its template is gone', async () => {
    const { dispatcher, runtime } = runtimeWith({})
    const adopted = { handle: 'adopted', worktreeId: 'w', title: null }
    runtime.dedupeTerminalCreate.mockImplementationOnce(async () => adopted)
    const response = await dispatcher.dispatch(
      request('terminal.create', {
        worktree: 'id:w',
        clientMutationId: 'm-1',
        reconcileExisting: true,
        agentTemplateId: 'advertising'
      })
    )
    expect(response).toMatchObject({ ok: true, result: { terminal: adopted } })
    expect(runtime.getAgentTemplateSettings).not.toHaveBeenCalled()
  })
})
