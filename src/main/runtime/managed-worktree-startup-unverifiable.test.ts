import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, makeRepo, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './omni-runtime'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'

const remoteCreate = vi.hoisted(() => vi.fn())
vi.mock('../ipc/worktree-remote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRemoteWorktree: remoteCreate
}))

let store: ReturnType<typeof createStore>
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'worktree-startup-receipt-'))
  store = createStore()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  remoteCreate.mockReset()
})
afterEach(async () => {
  await store.flushAsync()
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture() {
  const repo = makeRepo({ kind: 'folder', path: testState.dir })
  store.addRepo(repo)
  const runtime = new OrcaRuntimeService(store)
  const spawn = vi.fn(async (options: { worktreeId: string }) => ({
    id: `${options.worktreeId}@@worker`
  }))
  runtime.setPtyController({ spawn } as never)
  const activateWorktree = vi.fn()
  runtime.setNotifier({ activateWorktree, worktreesChanged: vi.fn() } as never)
  const registration = vi.spyOn(
    runtime as unknown as { assertPtyDidNotExitBeforeRegistration(): void },
    'assertPtyDidNotExitBeforeRegistration'
  )
  const create = (activate = false) =>
    runtime.createManagedWorktree({
      repoSelector: `id:${repo.id}`,
      name: 'routine-worker',
      startup: { command: 'echo worker' },
      activate
    })
  return { runtime, spawn, activateWorktree, registration, create }
}

describe('folder workspace startup creation receipts', () => {
  it.each([false, true])(
    'keeps one committed worker after failed registration with activation=%s',
    async (activate) => {
      const { create, spawn, activateWorktree, registration } = fixture()
      registration.mockImplementationOnce(() => {
        throw new Error('registration reply lost')
      })
      const result = await create(activate)
      expect(result.startupTerminalOutcome).toBe('unverifiable')
      expect(result.startupTerminal).toBeUndefined()
      expect(result.warning).toContain('registration reply lost')
      expect(store.getWorktreeMeta(result.worktree.id)).toBeDefined()
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(activateWorktree).not.toHaveBeenCalled()
    }
  )

  it('holds an unknown provider outcome even without a spawn commit receipt', async () => {
    const { create, spawn, activateWorktree } = fixture()
    spawn.mockRejectedValueOnce(
      Object.assign(new Error('owner reply lost'), { agentSessionOperationOutcome: 'unknown' })
    )
    const result = await create(true)
    expect(result.startupTerminalOutcome).toBe('unverifiable')
    expect(result.warning).toContain('owner reply lost')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(activateWorktree).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves the ordinary warning and fallback after prebirth refusal with activation=%s',
    async (activate) => {
      const { create, spawn, activateWorktree } = fixture()
      spawn.mockRejectedValueOnce(new Error('provider refused before birth'))
      const result = await create(activate)
      expect(result.startupTerminalOutcome).toBeUndefined()
      expect(result.warning).toContain('provider refused before birth')
      expect(spawn).toHaveBeenCalledTimes(activate ? 1 : 2)
      if (activate) {
        expect(activateWorktree).toHaveBeenCalledWith(
          'r1',
          result.worktree.id,
          undefined,
          { command: 'echo worker' },
          undefined
        )
      } else {
        expect(activateWorktree).not.toHaveBeenCalled()
      }
    }
  )
})

describe('remote Git workspace startup creation receipts', () => {
  it.each([false, true])(
    'preserves the partial workspace without activating or provisioning after an uncertain birth, activation=%s',
    async (activate) => {
      const repo = makeRepo({ path: testState.dir, connectionId: 'ssh-owner' })
      store.addRepo(repo)
      const runtime = new OrcaRuntimeService(store)
      const worktreeId = `${repo.id}::${testState.dir}`
      const created: CreateWorktreeResult = {
        worktree: {
          id: worktreeId,
          repoId: repo.id,
          path: testState.dir,
          head: 'abc',
          branch: 'worker',
          isBare: false,
          isMainWorktree: false,
          displayName: 'Worker'
        } as CreateWorktreeResult['worktree'],
        setup: { command: 'echo setup', runnerScriptPath: '/remote/setup.sh', envVars: {} }
      }
      remoteCreate.mockResolvedValue(created)
      vi.spyOn(
        runtime as unknown as { resolveTerminalWorkspaceLaunchScope(): Promise<unknown> },
        'resolveTerminalWorkspaceLaunchScope'
      ).mockResolvedValue({
        id: worktreeId,
        path: testState.dir,
        connectionId: 'ssh-owner',
        repo: null,
        folderWorkspace: null
      })
      const spawn = vi.fn(async () => ({ id: 'ssh:ssh-owner@@pty-1' }))
      runtime.setPtyController({ spawn } as never)
      const activateWorktree = vi.fn()
      runtime.setNotifier({ activateWorktree, worktreesChanged: vi.fn() } as never)
      vi.spyOn(
        runtime as unknown as { assertPtyDidNotExitBeforeRegistration(): void },
        'assertPtyDidNotExitBeforeRegistration'
      ).mockImplementationOnce(() => {
        throw new Error('remote registration reply lost')
      })
      const result = await runtime.createManagedWorktree({
        repoSelector: `id:${repo.id}`,
        name: 'worker',
        startup: { command: 'echo worker' },
        activate,
        awaitTerminalProvisioning: true
      })
      expect(result.worktree.id).toBe(worktreeId)
      expect(result.startupTerminalOutcome).toBe('unverifiable')
      expect(result.warning).toContain('remote registration reply lost')
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(activateWorktree).not.toHaveBeenCalled()
    }
  )
})
