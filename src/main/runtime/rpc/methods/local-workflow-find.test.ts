import { describe, expect, it, vi } from 'vitest'
import { LOCAL_WORKFLOW_METHODS } from '../../../../shared/local-workflow-rpc'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { OrcaRuntimeService as RuntimePrototype } from '../../omni-runtime'
import type { RpcContext, RpcMethod } from '../core'
import { LOCAL_WORKFLOW_RPC_METHODS } from './local-workflow'

function runtimeFor(options: { host?: string; linked?: boolean; window?: boolean } = {}) {
  const openLocalWorkflowFind = vi.fn(async () => ({
    conversationId: 'find-tab',
    executionId: '3f9a1c2e-0000-4000-8000-000000000000'
  }))
  const runtime = Object.assign(Object.create(RuntimePrototype.prototype), {
    resolveTerminalWorkspaceLaunchTarget: async () => ({
      scope: { id: 'workspace-1', path: '/work/app', connectionId: null },
      managedWorktree: { id: 'workspace-1', path: '/work/app', displayName: 'App' }
    }),
    getWorkspaceSessionHostIdForWorktree: () => options.host ?? 'local',
    getHubLinkedWorkspaceItem: () => (options.linked ? { hubTaskId: 'btk_123' } : null)
  }) as OrcaRuntimeService
  runtime.setNotifier(
    options.window === false ? null : ({ openLocalWorkflowFind } as unknown as never)
  )
  return { runtime, openLocalWorkflowFind }
}

const method = LOCAL_WORKFLOW_RPC_METHODS.find(
  (entry) => entry.name === LOCAL_WORKFLOW_METHODS.find
) as RpcMethod

function call(runtime: OrcaRuntimeService, request: unknown, context?: Partial<RpcContext>) {
  const params = method.params!.parse({ worktree: 'id:workspace-1', request })
  return method.handler(params, { runtime, ...context } as RpcContext)
}

describe('localWorkflow.find', () => {
  it('has the window start Find the best in the local workspace and returns the run', async () => {
    const { runtime, openLocalWorkflowFind } = runtimeFor()
    await expect(call(runtime, { prompt: 'Name the bakery', keep: 20 })).resolves.toEqual({
      worktreeId: 'workspace-1',
      conversationId: 'find-tab',
      executionId: '3f9a1c2e-0000-4000-8000-000000000000'
    })
    expect(openLocalWorkflowFind).toHaveBeenCalledWith('workspace-1', {
      prompt: 'Name the bakery',
      keep: 20
    })
  })

  it('refuses what a run started in the app would refuse, and names why', async () => {
    await expect(call(runtimeFor({ host: 'ssh:box' }).runtime, { prompt: 'x' })).rejects.toThrow(
      'local execution host'
    )
    await expect(call(runtimeFor({ linked: true }).runtime, { prompt: 'x' })).rejects.toThrow(
      'card-bound'
    )
    await expect(call(runtimeFor({ window: false }).runtime, { prompt: 'x' })).rejects.toThrow(
      'needs the OmniConsole window open'
    )
    await expect(
      call(runtimeFor().runtime, { prompt: 'x' }, { clientKind: 'mobile' } as Partial<RpcContext>)
    ).rejects.toThrow('desktop runtime')
  })

  it('checks the request before the window sees it', () => {
    for (const request of [
      { prompt: '' },
      { prompt: 'x', top: 9 },
      { prompt: 'x', keep: 101 },
      { prompt: 'x', items: ['only one'] },
      { prompt: 'x', surprise: true }
    ]) {
      expect(() => method.params!.parse({ worktree: 'id:workspace-1', request })).toThrow()
    }
  })
})

describe('localWorkflow.run', () => {
  const run = LOCAL_WORKFLOW_RPC_METHODS.find(
    (entry) => entry.name === LOCAL_WORKFLOW_METHODS.run
  ) as RpcMethod

  it('has the window start the template in the local workspace, refused as Find the best is', async () => {
    const { runtime, openLocalWorkflowFind } = runtimeFor()
    const request = { template: 'discover', prompt: 'Find bugs', routes: ['claude'] }
    const params = run.params!.parse({ worktree: 'id:workspace-1', request })
    await expect(run.handler(params, { runtime } as RpcContext)).resolves.toMatchObject({
      worktreeId: 'workspace-1',
      conversationId: 'find-tab'
    })
    expect(openLocalWorkflowFind).toHaveBeenCalledWith('workspace-1', request)
    const linked = runtimeFor({ linked: true }).runtime
    await expect(run.handler(params, { runtime: linked } as RpcContext)).rejects.toThrow(
      'The discover workflow is unavailable in card-bound workspaces.'
    )
    expect(() =>
      run.params!.parse({ worktree: 'id:workspace-1', request: { template: 'x', prompt: 'y' } })
    ).toThrow()
  })
})
