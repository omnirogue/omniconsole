import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  assertWorkerCompletionPolicyPlacement,
  checkSpawnedWorkerCompletionPolicy,
  prepareWorkerCompletionPolicy,
  resolveWorkerCompletionHostId
} from './orchestration-worker-completion-policy'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { readAutomaticWorkerCleanupHold } from '../../automatic-worker-cleanup-hold'

vi.mock('../../automatic-worker-cleanup-hold', () => ({
  readAutomaticWorkerCleanupHold: vi.fn().mockResolvedValue(null)
}))

const coordinator = { worktreeId: 'coordinator', paneKey: 'pane_coord' }
const runtime = { getTerminalPaneKey: () => 'pane_worker' } as unknown as OrcaRuntimeService
const input = (extras: Record<string, unknown> = {}) =>
  WorkerStartParams.parse({ task: 'task', from: 'term_coord', agent: 'codex', ...extras })

describe('disposable worker placement', () => {
  beforeEach(() => {
    vi.mocked(readAutomaticWorkerCleanupHold).mockReset().mockResolvedValue(null)
  })
  it.each([{ on: 'other-host' }, { terminal: 'term_existing' }])(
    'refuses retroactive or cross-host disposal: %o',
    (placement) => {
      expect(() =>
        assertWorkerCompletionPolicyPlacement(
          WorkerStartParams.parse({
            task: 'task',
            from: 'term_coord',
            closeOnCompletion: true,
            ...placement
          })
        )
      ).toThrow('newly created local worker')
    }
  )
  it('keeps existing remote and reused placement behavior when the flag is omitted', () => {
    expect(() =>
      assertWorkerCompletionPolicyPlacement(
        WorkerStartParams.parse({
          task: 'task',
          from: 'term_coord',
          terminal: 'existing',
          on: 'other-host'
        })
      )
    ).not.toThrow()
  })
  it('refuses explicit finite cleanup on Windows before launch', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      expect(() =>
        assertWorkerCompletionPolicyPlacement(input({ closeOnCompletion: true }))
      ).toThrow('unavailable on Windows')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
  it('defaults a new local Claude or Codex worker, while explicit opt-out and other agents retain', async () => {
    if (process.platform === 'win32') {
      return
    }
    for (const agent of ['claude', 'codex']) {
      expect(
        await prepareWorkerCompletionPolicy(
          runtime,
          input({ agent }),
          coordinator,
          'worker',
          agent,
          'local'
        )
      ).toMatchObject({ kind: 'release_on_accepted_completion' })
    }
    expect(
      await prepareWorkerCompletionPolicy(
        runtime,
        input({ closeOnCompletion: false }),
        coordinator,
        'worker',
        'codex',
        'local'
      )
    ).toBeUndefined()
    expect(
      await prepareWorkerCompletionPolicy(
        runtime,
        input({ agent: 'gemini' }),
        coordinator,
        'worker',
        'gemini',
        'local'
      )
    ).toBeUndefined()
    expect(
      await prepareWorkerCompletionPolicy(
        runtime,
        input({ terminal: 'existing' }),
        coordinator,
        'worker',
        'codex',
        'local'
      )
    ).toBeUndefined()
    expect(
      await prepareWorkerCompletionPolicy(
        runtime,
        input(),
        coordinator,
        'worker',
        'codex',
        'ssh:remote'
      )
    ).toBeUndefined()
  })
  it('resolves an unstamped folder from its repo while withholding remote or unknown ownership', async () => {
    if (process.platform === 'win32') {
      return
    }
    const folder = { repoId: 'folder-repo' }
    const localRuntime = {
      showRepo: vi.fn(async () => ({ connectionId: null, executionHostId: null }))
    } as unknown as OrcaRuntimeService
    const localHost = await resolveWorkerCompletionHostId(localRuntime, folder)
    expect(localHost).toBe('local')
    expect(
      await prepareWorkerCompletionPolicy(
        runtime,
        input(),
        coordinator,
        'worker',
        'codex',
        localHost
      )
    ).toMatchObject({ kind: 'release_on_accepted_completion' })

    const remoteRuntime = {
      showRepo: vi.fn(async () => ({ connectionId: 'studio', executionHostId: null }))
    } as unknown as OrcaRuntimeService
    const remoteHost = await resolveWorkerCompletionHostId(remoteRuntime, folder)
    expect(remoteHost).toBe('ssh:studio')
    expect(
      await prepareWorkerCompletionPolicy(
        runtime,
        input(),
        coordinator,
        'worker',
        'codex',
        remoteHost
      )
    ).toBeUndefined()

    const missingRuntime = {
      showRepo: vi.fn(async () => {
        throw new Error('repo missing')
      })
    } as unknown as OrcaRuntimeService
    expect(await resolveWorkerCompletionHostId(missingRuntime, folder)).toBeUndefined()
    expect(await resolveWorkerCompletionHostId(localRuntime, {})).toBeUndefined()
  })
  it('retains an implicit worker when prospective protection is held, while explicit opt-in still rejects', async () => {
    vi.mocked(readAutomaticWorkerCleanupHold).mockResolvedValueOnce('protected-workspace')
    expect(
      await prepareWorkerCompletionPolicy(runtime, input(), coordinator, 'worker', 'codex', 'local')
    ).toBeUndefined()
    vi.mocked(readAutomaticWorkerCleanupHold).mockResolvedValueOnce('protected-workspace')
    await expect(
      prepareWorkerCompletionPolicy(
        runtime,
        input({ closeOnCompletion: true }),
        coordinator,
        'worker',
        'codex',
        'local'
      )
    ).rejects.toThrow('protected-workspace')
  })
  it('rechecks the actual pane before an implicit release policy remains durable', async () => {
    vi.mocked(readAutomaticWorkerCleanupHold).mockImplementation(async (_runtime, target) =>
      target.paneKey === 'pane_worker' ? 'pinned' : null
    )
    expect(
      await checkSpawnedWorkerCompletionPolicy(
        runtime,
        { kind: 'release_on_accepted_completion', coordinator },
        'worker',
        'term_worker'
      )
    ).toBe('pinned')
  })
})
