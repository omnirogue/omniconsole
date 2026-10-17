import { createHash } from 'node:crypto'
import { SESSION_TAB_METHODS } from './session-tabs'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { RpcDispatcher } from '../dispatcher'
import { AGENT_SESSION_METHODS } from './agent-session'
import { TERMINAL_METHODS } from './terminal'
import { createExistingWorktreeWorkerTerminal } from './orchestration-worker-topology'

const operationHash = '4e7b19abc4954551bc8c786fa722f5281ffa0b7fee9a5152ac75c77f59bd9464'
const operationId = '1752883200000-0123456789abcdef0123456789abcdef'
describe('RPC creator provenance', () => {
  it.each([
    ['createAgentSession', 'agent-session-create'],
    ['ensureAgentSession', 'agent-session-resume']
  ] as const)('%s constructs authenticated paired device cause', async (method, trigger) => {
    const fn = vi.fn().mockResolvedValue({
      terminal: { handle: 'term_55555555-5555-4555-8555-555555555555' },
      disposition: 'created'
    })
    const runtime = { getRuntimeId: () => 'runtime-1', [method]: fn }
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
    const params =
      method === 'createAgentSession'
        ? {
            clientOperationId: operationId,
            worktree: 'id:folder:99999999-9999-4999-8999-999999999999',
            agent: 'codex'
          }
        : {
            kind: 'explicit',
            worktree: 'id:folder:99999999-9999-4999-8999-999999999999',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
          }
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        authToken: 'token',
        method: `terminal.${method}`,
        params
      },
      (reply) => replies.push(reply),
      {
        pairedDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        clientKind: 'runtime',
        clientId: 'bearer-secret'
      }
    )
    const caller = fn.mock.calls[0]?.[1]
    expect(caller?.launchCause).toEqual({
      trigger,
      actor: {
        kind: 'paired-device',
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        clientKind: 'runtime'
      },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      ...(method === 'createAgentSession' ? { clientMutationIdHash: operationHash } : {})
    })
    expect(JSON.stringify(caller.launchCause)).not.toContain('bearer-secret')
    expect(caller.launchCause).not.toHaveProperty('clientId')
  })
  it.each([
    ['createAgentSession', 'agent-session-create'],
    ['ensureAgentSession', 'agent-session-resume']
  ] as const)('%s identifies the local socket as local-cli', async (method, trigger) => {
    const fn = vi.fn().mockResolvedValue({
      terminal: { handle: 'term_55555555-5555-4555-8555-555555555555' },
      disposition: 'created'
    })
    const dispatcher = new RpcDispatcher({
      runtime: { getRuntimeId: () => 'runtime-1', [method]: fn } as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
    await dispatcher.dispatch({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      authToken: 'token',
      method: `terminal.${method}`,
      params:
        method === 'createAgentSession'
          ? {
              clientOperationId: operationId,
              worktree: 'id:folder:99999999-9999-4999-8999-999999999999',
              agent: 'codex'
            }
          : {
              kind: 'explicit',
              worktree: 'id:folder:99999999-9999-4999-8999-999999999999',
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
            }
    })
    expect(fn.mock.calls[0]?.[1]?.launchCause).toEqual({
      trigger,
      actor: { kind: 'local-cli' },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      ...(method === 'createAgentSession' ? { clientMutationIdHash: operationHash } : {})
    })
  })
  it.each(['createAgentSession', 'create'] as const)(
    '%s records remote routine ownership as claimed while deriving actor and request id',
    async (method) => {
      const fn = vi.fn().mockResolvedValue({
        terminal: { handle: 'term_55555555-5555-4555-8555-555555555555' },
        handle: 'term_55555555-5555-4555-8555-555555555555'
      })
      const runtime = {
        getRuntimeId: () => 'runtime-1',
        createAgentSession: fn,
        createTerminal: fn,
        dedupeTerminalCreate: vi.fn(async (_client, worktree, _mutation, _reconcile, run) =>
          run(worktree)
        )
      }
      const dispatcher = new RpcDispatcher({
        runtime: runtime as unknown as OrcaRuntimeService,
        methods: [...AGENT_SESSION_METHODS, ...TERMINAL_METHODS]
      })
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          authToken: 'token',
          method: `terminal.${method}`,
          params: {
            worktree: 'id:folder:99999999-9999-4999-8999-999999999999',
            ...(method === 'createAgentSession'
              ? { agent: 'claude', clientOperationId: operationId }
              : {}),
            launchCause: {
              trigger: 'automation',
              reference: {
                automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                automationRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                prompt: 'private'
              },
              actor: { kind: 'local-cli', deviceId: 'forged' },
              requestId: 'forged'
            }
          }
        },
        (reply) => replies.push(reply),
        {
          pairedDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          clientKind: 'runtime',
          clientId: 'bearer-secret'
        }
      )
      const reply = JSON.parse(replies.at(-1)!)
      expect(reply.ok).toBe(true)
      expect(fn.mock.calls[0]?.[1]?.launchCause).toEqual({
        trigger: method === 'createAgentSession' ? 'agent-session-create' : 'terminal-create',
        claimedTrigger: 'automation',
        claimedReferenceHashes: {
          automationId: `hash_${createHash('sha256').update('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').digest('hex').slice(0, 12)}`,
          automationRunId: `hash_${createHash('sha256').update('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').digest('hex').slice(0, 12)}`
        },
        actor: {
          kind: 'paired-device',
          deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          clientKind: 'runtime'
        },
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        ...(method === 'createAgentSession' ? { clientMutationIdHash: operationHash } : {})
      })
    }
  )
  it.each([
    [{}, 'cli', { kind: 'local-cli' }],
    [
      { pairedDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', clientKind: 'runtime' },
      'paired-client',
      {
        kind: 'paired-device',
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        clientKind: 'runtime'
      }
    ],
    [
      { pairedDeviceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', clientKind: 'mobile' },
      'mobile-wake',
      { kind: 'mobile', deviceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', clientKind: 'mobile' }
    ]
  ])('terminal.create constructs cause for %j', async (identity, _trigger, actor) => {
    const createTerminal = vi
      .fn()
      .mockResolvedValue({ handle: 'term_55555555-5555-4555-8555-555555555555' })
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      createTerminal,
      dedupeTerminalCreate: vi.fn(async (_client, worktree, _mutation, _reconcile, run) =>
        run(worktree, undefined)
      )
    }
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: TERMINAL_METHODS
    })
    await dispatcher.dispatchStreaming(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        authToken: 'token',
        method: 'terminal.create',
        params: { worktree: 'id:folder:99999999-9999-4999-8999-999999999999' }
      },
      () => {},
      identity as never
    )
    expect(createTerminal.mock.calls[0]?.[1]?.launchCause).toEqual({
      trigger: 'terminal-create',
      actor,
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })
  })
  it('orchestration worker passes its task id to createTerminal', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      handle: 'term_55555555-5555-4555-8555-555555555555',
      surface: 'background'
    })
    await createExistingWorktreeWorkerTerminal({
      runtime: { createTerminal } as unknown as OrcaRuntimeService,
      worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
      agent: 'codex',
      taskId: 'task_111111111111',
      effects: []
    })
    expect(createTerminal.mock.calls[0]?.[1]?.launchCause).toEqual({
      trigger: 'orchestration-worker',
      reference: { orchestrationTaskId: 'task_111111111111' }
    })
  })
})

describe('opaque mutation ids on the public RPC routes', () => {
  it.each(['terminal.create', 'session.tabs.createTerminal'])(
    '%s preserves the supported mutation contract and transport request separately',
    async (method) => {
      const create = vi
        .fn()
        .mockResolvedValue({ handle: 'term_55555555-5555-4555-8555-555555555555' })
      const dispatcher = new RpcDispatcher({
        runtime: {
          getRuntimeId: () => 'runtime-1',
          createTerminal: create,
          createMobileSessionTerminal: create,
          dedupeTerminalCreate: vi.fn(async (_client, worktree, _mutation, _reconcile, run) =>
            run(worktree)
          )
        } as unknown as OrcaRuntimeService,
        methods: [...TERMINAL_METHODS, ...SESSION_TAB_METHODS]
      })
      const mutation = 'create-1'
      const response = await dispatcher.dispatch({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        authToken: 'token',
        method,
        params: {
          worktree: 'id:folder:99999999-9999-4999-8999-999999999999',
          clientMutationId: mutation
        }
      })
      expect(response.ok).toBe(true)
      expect(create.mock.calls[0][1].launchCause).toEqual({
        trigger: method === 'terminal.create' ? 'terminal-create' : 'session-tabs-create',
        actor: { kind: 'local-cli' },
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        clientMutationIdHash: createHash('sha256').update(mutation).digest('hex')
      })
    }
  )
})
