import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleLocalExecutionView } from '../../shared/console-local-execution'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { activateApprovedConsoleJob } from './console-job-activation'
import * as jobLaunch from './console-job-launch'
import type { ConsoleLocalExecutionPort } from './console-local-execution-contract'
import { materializeConsoleCurrentGitSource } from './console-current-git-materialization'
import { hydrateConsoleFolderCandidate } from './console-folder-round-snapshot'
import {
  createConsoleCurrentGitFixture,
  currentGitAcceptedCandidate,
  currentGitActivation
} from './console-current-git-test-fixture'

describe('captured Git job activation ordering', () => {
  let f: Awaited<ReturnType<typeof createConsoleCurrentGitFixture>>
  beforeEach(async () => {
    f = await createConsoleCurrentGitFixture()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(f.directory, { recursive: true, force: true })
  })

  function activationHarness() {
    const events: string[] = []
    const path = join(f.directory, 'activated')
    const runtime = {
      showManagedTerminalWorkspace: vi.fn(async (selector: string) => {
        expect(['id:source', 'id:activated']).toContain(selector)
        return {
          id: selector === 'id:source' ? 'source' : 'activated',
          repoId: 'repo',
          hostId: 'local',
          git: { path: selector === 'id:source' ? f.cwd : path }
        }
      }),
      showRepo: vi.fn(async () => ({
        id: 'repo',
        path: f.cwd,
        kind: 'git',
        executionHostId: 'local'
      })),
      listManagedWorktrees: vi.fn(async () => ({ worktrees: [], truncated: false })),
      createManagedWorktree: vi.fn(
        async (args: { baseBranch: string; branchNameOverride: string }) => {
          expect(events).toEqual(['claim'])
          expect(args).toMatchObject({
            baseBranch: f.job.baseSha,
            branchNameOverride: `omni/${f.job.id}`,
            runHooks: false,
            setupDecision: 'skip'
          })
          await f.git(['worktree', 'add', '-b', args.branchNameOverride, path, args.baseBranch])
          expect((await f.git(['status', '--porcelain'], path)).stdout).toBe('')
          expect((await f.git(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(f.job.baseSha)
          events.push('worktree')
          return { worktree: { id: 'activated', git: { path, branch: args.branchNameOverride } } }
        }
      )
    }
    const port: ConsoleLocalExecutionPort = {
      getReadyJob: vi.fn(async () => ({ ok: true as const, data: f.job })),
      activate: vi.fn(async () => {
        events.push('claim')
        return {
          ok: true as const,
          data: { ...currentGitActivation(f.job), job: { ...f.job, state: 'running' } }
        }
      }),
      prepareInputs: vi.fn(async () => {
        throw new Error('Unexpected original-source download.')
      }),
      hydrateFolderCandidate: vi.fn(async () => {
        throw new Error('Unexpected repair-candidate hydration.')
      }),
      principal: vi.fn(async () => currentGitActivation(f.job).principal),
      sanitize: (value) => value,
      inspect: vi.fn(async () => ({ ok: true as const, data: { cancelled: false } })),
      result: vi.fn(async () => ({ ok: true as const, data: null })),
      cancelled: vi.fn(async () => ({ ok: true as const, data: null }))
    }
    const view: ConsoleLocalExecutionView = {
      jobId: f.job.id,
      workflowId: f.job.workflowId,
      cardId: f.job.taskId,
      runId: 'run_activation',
      dispatchId: 'dispatch_activation',
      terminalHandle: 'terminal_activation',
      worktreeId: 'activated',
      branch: `omni/${f.job.id}`,
      state: 'running'
    }
    const launch = vi.spyOn(jobLaunch, 'launchConsoleJob').mockResolvedValue(view)
    const call = vi.fn(async () => {
      throw new Error('Unexpected worker RPC.')
    })
    const start = () =>
      activateApprovedConsoleJob({
        runtime: runtime as unknown as OrcaRuntimeService,
        call,
        port,
        results: { read: vi.fn(() => null), record: vi.fn(), flush: vi.fn(async () => {}) },
        records: async () => [],
        request: {
          jobId: f.job.id,
          workflowId: f.job.workflowId,
          approvedDigest: f.job.digest,
          worktree: 'id:source'
        }
      })
    return { events, path, runtime, port, view, launch, call, start }
  }

  async function assertCommittedBaseline(path: string) {
    expect((await f.git(['status', '--porcelain'], path)).stdout).toBe('')
    expect((await f.git(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(f.job.baseSha)
    expect(await readFile(join(path, 'selected.txt'), 'utf8')).toBe('committed source\n')
    expect(await readFile(join(path, 'deleted.txt'), 'utf8')).toBe('committed deletion\n')
    await expect(readFile(join(path, 'outputs/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  }

  async function prepareAcceptedRepair() {
    const first = await f.worktree()
    await materializeConsoleCurrentGitSource(f.job, first.path, f.preparedInputPaths)
    await writeFile(join(first.path, 'selected.txt'), 'accepted repaired bytes\n')
    await rm(join(first.path, 'outputs/new.txt'))
    const accepted = await currentGitAcceptedCandidate(f.job, first.path)
    f.input.loop_stage.round = 2
    f.input.source_overlay = false
    Object.assign(f.input, { folder_candidate: accepted.candidate })
    return accepted
  }

  it.each(['review', 'repair'] as const)(
    'claims and creates a clean exact-HEAD worktree before preparing the initial %s capture',
    async (action) => {
      f.job.action = action
      f.job.readOnly = action === 'review'
      f.job.artifactResult!.path =
        action === 'review' ? 'folder-review.json' : 'folder-snapshot.json'
      f.input.loop_stage.role = action === 'review' ? 'participant' : 'repair'
      await writeFile(join(f.cwd, 'selected.txt'), 'newer source session edit\n')
      const originalSource = structuredClone(f.input.current_source)
      const h = activationHarness()
      vi.mocked(h.port.prepareInputs!).mockImplementation(async (job, path) => {
        expect(h.events).toEqual(['claim', 'worktree'])
        expect(job.state).toBe('running')
        expect(path).toBe(h.path)
        await assertCommittedBaseline(path)
        h.events.push('prepare')
        return f.preparedInputPaths
      })
      h.launch.mockImplementation(async ({ activation, worktree, preparedInputPaths }) => {
        h.events.push('launch')
        expect(worktree).toMatchObject({ path: h.path, startSha: f.job.baseSha })
        expect(preparedInputPaths).toEqual(f.preparedInputPaths)
        expect(activation.job.inputs[0]).toMatchObject({ current_source: originalSource })
        expect(await readFile(join(h.path, 'selected.txt'), 'utf8')).toBe('captured dirty source\n')
        expect(await readFile(join(h.path, 'outputs/new.txt'), 'utf8')).toBe(
          'captured untracked output\n'
        )
        expect(await readFile(join(h.path, 'untouched.txt'), 'utf8')).toBe(
          'unselected committed source\n'
        )
        await expect(readFile(join(h.path, 'deleted.txt'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
        expect((await f.git(['rev-parse', 'HEAD'], h.path)).stdout.trim()).toBe(f.job.baseSha)
        return h.view
      })

      expect(await h.start()).toEqual(h.view)

      expect(h.events).toEqual(['claim', 'worktree', 'prepare', 'launch'])
      expect(h.port.hydrateFolderCandidate).not.toHaveBeenCalled()
      expect(h.launch).toHaveBeenCalledOnce()
      expect(h.call).not.toHaveBeenCalled()
      expect(await readFile(join(f.cwd, 'selected.txt'), 'utf8')).toBe(
        'newer source session edit\n'
      )
      expect(await readFile(join(f.cwd, 'outputs/new.txt'), 'utf8')).toBe(
        'captured untracked output\n'
      )
      await expect(readFile(join(f.cwd, 'deleted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.input.current_source).toEqual(originalSource)
    }
  )

  it('hydrates accepted round-two bytes and omissions before launch without downloading original inputs', async () => {
    const originalSource = structuredClone(f.input.current_source)
    const { artifact, candidate } = await prepareAcceptedRepair()
    const h = activationHarness()
    vi.mocked(h.port.hydrateFolderCandidate!).mockImplementation(
      async (activation, workspacePath) => {
        expect(h.events).toEqual(['claim', 'worktree'])
        await assertCommittedBaseline(workspacePath)
        h.events.push('hydrate')
        await hydrateConsoleFolderCandidate({
          activation,
          workspacePath,
          candidate,
          contentBase64: artifact.contentBase64
        })
      }
    )
    h.launch.mockImplementation(async ({ activation, worktree, preparedInputPaths }) => {
      h.events.push('launch')
      expect(preparedInputPaths).toEqual([])
      expect(activation.job.inputs[0]).toMatchObject({ current_source: originalSource })
      expect(await readFile(join(worktree.path, 'selected.txt'), 'utf8')).toBe(
        'accepted repaired bytes\n'
      )
      await expect(readFile(join(worktree.path, 'outputs/new.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(readFile(join(worktree.path, 'deleted.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(await readFile(join(worktree.path, 'untouched.txt'), 'utf8')).toBe(
        'unselected committed source\n'
      )
      expect((await f.git(['rev-parse', 'HEAD'], worktree.path)).stdout.trim()).toBe(f.job.baseSha)
      return h.view
    })

    expect(await h.start()).toEqual(h.view)

    expect(h.events).toEqual(['claim', 'worktree', 'hydrate', 'launch'])
    expect(h.port.prepareInputs).not.toHaveBeenCalled()
    expect(h.launch).toHaveBeenCalledOnce()
    expect(f.input.current_source).toEqual(originalSource)
    expect(await readFile(join(f.cwd, 'selected.txt'), 'utf8')).toBe('captured dirty source\n')
    expect(await readFile(join(f.cwd, 'outputs/new.txt'), 'utf8')).toBe(
      'captured untracked output\n'
    )
  })

  it('prevents launch and preserves the clean checkout when candidate hydration rejects tampered bytes', async () => {
    const { candidate } = await prepareAcceptedRepair()
    const h = activationHarness()
    vi.mocked(h.port.hydrateFolderCandidate!).mockImplementation(
      async (activation, workspacePath) => {
        h.events.push('hydrate')
        await hydrateConsoleFolderCandidate({
          activation,
          workspacePath,
          candidate,
          contentBase64: Buffer.from('tampered accepted artifact').toString('base64')
        })
      }
    )

    await expect(h.start()).rejects.toThrow('accepted artifact')

    expect(h.events).toEqual(['claim', 'worktree', 'hydrate'])
    expect(h.port.prepareInputs).not.toHaveBeenCalled()
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.call).not.toHaveBeenCalled()
    await assertCommittedBaseline(h.path)
  })
})
