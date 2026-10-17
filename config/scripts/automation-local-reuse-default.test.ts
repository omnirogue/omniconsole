import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, makeRepo, testState } from '../../src/main/persistence-test-harness'
import { OrcaRuntimeService } from '../../src/main/runtime/omni-runtime'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { AUTOMATION_METHODS } from '../../src/main/runtime/rpc/methods/automations'
import { AUTOMATION_HANDLERS } from '../../src/cli/handlers/automations'
import type { RuntimeClient } from '../../src/cli/runtime-client'
import type { Automation, AutomationCreateInput } from '../../src/shared/automations-types'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'

let store: ReturnType<typeof createStore>
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'routine-default-'))
  store = createStore()
})
afterEach(async () => {
  await store.flushAsync()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

it.each(['store', 'RPC', 'CLI'] as const)(
  '%s creation preserves local/remote defaults and explicit choices',
  async (path) => {
    const local = makeRepo({ id: 'local' })
    const ssh = makeRepo({ id: 'ssh', connectionId: 'ssh-1' })
    const remote = makeRepo({ id: 'remote', executionHostId: 'runtime:paired' })
    for (const repo of [local, ssh, remote]) {
      store.addRepo(repo)
    }
    const group = store.createProjectGroup({
      name: 'Folder',
      parentPath: '/folder',
      createdFrom: 'folder-scan'
    })
    const folder = store.createFolderWorkspace({ projectGroupId: group.id, folderPath: '/folder' })
    const pinned = store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/ssh-folder',
      connectionId: 'ssh-1'
    })
    const workspaces = new Map<string, { id: string; repoId: string; path: string }>([
      ...[local, ssh, remote].map(
        (repo) =>
          [
            `${repo.id}::${repo.path}`,
            { id: `${repo.id}::${repo.path}`, repoId: repo.id, path: repo.path }
          ] as const
      ),
      [
        folderWorkspaceKey(folder.id),
        { id: folderWorkspaceKey(folder.id), repoId: local.id, path: folder.folderPath }
      ],
      [
        folderWorkspaceKey(pinned.id),
        { id: folderWorkspaceKey(pinned.id), repoId: local.id, path: pinned.folderPath }
      ]
    ])
    const runtime = new OrcaRuntimeService(store)
    vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(
      async (selector) => workspaces.get(selector.replace(/^id:/, ''))! as never
    )
    vi.spyOn(runtime, 'showRepo').mockImplementation(
      async (selector) => store.getRepo(selector.replace(/^id:/, ''))! as never
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const client = {
      call: async (method: string, params: Record<string, string>) => {
        if (method === 'worktree.show') {
          return { result: { worktree: await runtime.showManagedWorktree(params.worktree) } }
        }
        if (method === 'repo.show') {
          return { result: { repo: await runtime.showRepo(params.repo) } }
        }
        if (method === 'ssh.listTargetSummaries') {
          return { result: { targets: [{ id: 'ssh-1' }] } }
        }
        const result = await dispatcher.dispatch({ id: 'test', authToken: 'test', method, params })
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        return result
      }
    } as unknown as RuntimeClient
    const create = async (
      projectId: string,
      workspaceId?: string,
      reuseSession?: boolean
    ): Promise<Automation> => {
      const input: AutomationCreateInput = {
        projectId,
        workspaceId,
        workspaceMode: workspaceId ? 'existing' : 'new_per_run',
        name: 'Check',
        prompt: 'Check',
        agentId: 'claude',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: Date.now(),
        ...(reuseSession === undefined ? {} : { reuseSession })
      }
      if (path === 'store') {
        return store.createAutomation(input)
      }
      if (path === 'RPC') {
        const result = await dispatcher.dispatch({
          id: 'create',
          authToken: 'test',
          method: 'automation.create',
          params: {
            ...input,
            repo: projectId,
            workspace: workspaceId ? `id:${workspaceId}` : undefined
          }
        })
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        return (result.result as { automation: Automation }).automation
      }
      const flags = new Map<string, string | boolean>([
        ['name', 'Check'],
        ['prompt', 'Check'],
        ['provider', 'claude'],
        ['trigger', 'daily'],
        [workspaceId ? 'workspace' : 'repo', `id:${workspaceId ?? projectId}`]
      ])
      if (reuseSession !== undefined) {
        flags.set(reuseSession ? 'reuse-session' : 'fresh-session', true)
      }
      await AUTOMATION_HANDLERS['automations create']({ flags, client, cwd: '/repo', json: true })
      return store.listAutomations().find((row) => !createdIds.has(row.id))!
    }
    const createdIds = new Set<string>()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cases = [
      ['local', 'local::/repo', undefined, true],
      ['local', 'local::/repo', false, false],
      ['ssh', 'ssh::/repo', undefined, false],
      ['remote', 'remote::/repo', undefined, false],
      ['local', undefined, undefined, false],
      ['local', folderWorkspaceKey(folder.id), undefined, true],
      ['local', folderWorkspaceKey(pinned.id), undefined, false]
    ] as const
    const results: boolean[] = []
    for (const [project, workspace, choice, expected] of cases) {
      if (path === 'CLI' && workspace === folderWorkspaceKey(pinned.id)) {
        await expect(create(project, workspace, choice)).rejects.toThrow(
          'automation_destination_invalid'
        )
        continue
      }
      const created = await create(project, workspace, choice)
      createdIds.add(created.id)
      results.push(created.reuseSession)
      expect(created.reuseSession, `${path}: ${project}/${workspace}/${choice}`).toBe(expected)
    }
    expect(results.filter(Boolean)).toHaveLength(2)
    expect(store.listAutomations()).toHaveLength(path === 'CLI' ? 6 : 7)
    await store.flushPendingOrThrowAsync()
    const restored = createStore()
    expect(
      restored.listAutomations().find((row) => row.id === [...createdIds][1])?.reuseSession
    ).toBe(false)
    expect(
      restored.updateAutomation([...createdIds][1], { name: 'Renamed saved routine' }).reuseSession
    ).toBe(false)
    await restored.flushAsync()
  }
)
