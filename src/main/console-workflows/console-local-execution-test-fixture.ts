import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { expect, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import { ConsoleLocalExecution } from './console-local-execution'
import type {
  ConsoleLocalJob,
  ConsoleLocalExecutionPort,
  ConsoleLocalResult
} from './console-local-execution-contract'
import type { ConsoleResultJournal } from './console-job-monitor'

export async function createConsoleLocalExecutionFixture(
  options: { workspaceKind?: 'git' | 'folder' } = {}
) {
  const folder = options.workspaceKind === 'folder'
  const principal = 'a'.repeat(64)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'console-local-'))
  const directory = folder ? await realpath(temporaryDirectory) : temporaryDirectory
  const cwd = join(directory, 'repo')
  const git = (args: string[], path = cwd) => gitExecFileAsync(args, { cwd: path })
  if (folder) {
    await mkdir(cwd)
  } else {
    await gitExecFileAsync(['init', cwd], { cwd: directory })
    await git(['config', 'user.name', 'Workflow test'])
    await git(['config', 'user.email', 'workflow@example.invalid'])
    await git(['remote', 'add', 'origin', 'https://gitlab.example/team/project.git'])
  }
  await writeFile(join(cwd, 'README.md'), 'fixture\n')
  if (!folder) {
    await git(['add', '.'])
    await git(['commit', '-m', 'initial'])
  }
  const job: ConsoleLocalJob = {
    id: 'job_local1234',
    taskId: 'btk_localfixture',
    workflowId: 'wf_fixture',
    digest: 'b'.repeat(64),
    state: 'ready',
    placement: 'local',
    provider: 'codex',
    model: 'gpt-6',
    effort: 'high',
    title: 'Local fixture',
    ...(folder ? { workspace: { kind: 'folder' as const, path: cwd } } : {}),
    repo: folder ? null : 'gitlab.example/team/project',
    baseSha: folder ? null : (await git(['rev-parse', 'HEAD'])).stdout.trim(),
    baseBranch: folder ? null : 'main',
    prompt: 'Exact stored prompt',
    brief: 'Exact stored brief',
    acceptance: 'Pass acceptance',
    acceptanceCommands: folder
      ? []
      : [{ program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    inputs: ['explicit-input'],
    ownedPaths: ['README.md'],
    readOnly: false,
    ...(folder ? {} : { reviewProvider: 'gitlab' as const })
  }
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  const checkout = join(directory, 'job')
  const worktree = {
    id: folder ? 'folder:local-fixture' : 'job-worktree',
    repoId: folder ? 'folder-workspace:local-fixture' : 'repo',
    hostId: 'local',
    git: { path: folder ? cwd : checkout, branch: folder ? '' : `omni/${job.id}` }
  }
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(
    async (selector) =>
      (!folder && selector === 'id:source'
        ? { id: 'source', repoId: 'repo', hostId: 'local', git: { path: cwd } }
        : worktree) as never
  )
  vi.spyOn(runtime, 'showRepo').mockImplementation(async () => {
    if (folder) {
      throw new Error('A native folder workspace has no repository record.')
    }
    return { id: 'repo', path: cwd, kind: 'git', executionHostId: 'local' } as never
  })
  vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
    worktrees: [],
    truncated: false
  } as never)
  vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
    await git(['worktree', 'add', '-b', args.branchNameOverride!, checkout, args.baseBranch!])
    return { worktree } as never
  })
  let terminals = 0
  const gates = new Map<string, PtyLaunchGateReceipt>()
  const acknowledgements = new Map<string, string>()
  let physicalExit: { exitCode: number | null; signal: number | null } | null = null
  const exitGate = (exitCode: number | null, signal: number | null = null): void => {
    physicalExit = { exitCode, signal }
  }
  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_selector, options) => {
    const handle = `term_local_${++terminals}`
    const gate: PtyLaunchGateReceipt | undefined = options?.launchGate
      ? {
          version: 1,
          state: 'closed',
          launchId: options.launchGate.launchId,
          gateId: randomUUID(),
          ptyId: `pty-${handle}`,
          incarnationId: randomUUID(),
          pid: 311,
          processStartTimeMs: Date.now(),
          processKind: 'pty-shell',
          ptyRootPid: 310,
          ptyRootProcessStartTimeMs: Date.now(),
          reportsChildExitStatus: true,
          exitObserver: 'macos-kqueue',
          startupCommandMode: 'exec'
        }
      : undefined
    if (gate) {
      gates.set(handle, gate)
    }
    return { handle, worktreeId: worktree.id, title: null, ...(gate ? { launchGate: gate } : {}) }
  })
  vi.spyOn(runtime, 'releaseTerminalLaunchGate').mockImplementation(async (_handle, input) => {
    expect(
      db.db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE payload LIKE '%release_intent%'")
        .get()
    ).toMatchObject({ count: 1 })
    acknowledgements.set(input.gate.gateId, input.startAcknowledgement)
    return {
      gateId: input.gate.gateId,
      state: 'released',
      startAcknowledgement: input.startAcknowledgement
    }
  })
  vi.spyOn(runtime, 'readTerminalLaunchGateObservation').mockImplementation(async (gate) => ({
    gateId: gate.gateId,
    ptyId: gate.ptyId,
    incarnationId: gate.incarnationId,
    pid: gate.pid,
    processStartTimeMs: gate.processStartTimeMs,
    startAcknowledgement: acknowledgements.get(gate.gateId) ?? null,
    ...(physicalExit
      ? {
          state: 'exited' as const,
          source: 'macos-kqueue' as const,
          ...physicalExit,
          waitStatus: physicalExit.signal ?? physicalExit.exitCode! * 256,
          observedAtMs: Date.now()
        }
      : { state: 'live' as const, source: 'macos-kqueue' as const })
  }))
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
    (handle) => `${handle}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
    runtime.getTerminalPaneKey(handle)
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    gates.has(handle)
      ? `${gates.get(handle)!.ptyId}:${gates.get(handle)!.incarnationId}`
      : `${handle}:process:1`
  )
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async (handle) =>
      ({ handle, worktreeId: worktree.id, connected: true, status: 'running' }) as never
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('omni')
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    condition: 'tui-idle',
    satisfied: true,
    status: 'running'
  } as never)
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, prompt) => ({
    handle,
    accepted: true,
    bytesWritten: prompt.length
  }))
  const port: ConsoleLocalExecutionPort = {
    captureLaunchAuthority: async () => ({ principal, isCurrent: () => true }),
    getReadyJob: vi.fn(async () => ({ ok: true as const, data: job })),
    activate: vi.fn(async () => ({
      ok: true as const,
      data: {
        job,
        principal,
        binding: {
          ...consoleJobClaimFixture,
          taskId: job.taskId,
          workflowId: job.workflowId,
          jobId: job.id,
          attempt: 1,
          leaseGeneration: 3
        }
      }
    })),
    startProcess: vi.fn(async (input) => ({
      ok: true as const,
      data: {
        ...input.binding,
        sessionId: 'ses_server',
        attemptId: 'attempt_server',
        inputDigest: input.inputDigest
      }
    })),
    publishFolderArtifact: vi.fn(async (input) => ({
      ok: true as const,
      data: {
        fileId: 'tfl_folderartifact',
        sha256: createHash('sha256')
          .update(Buffer.from(input.contentBase64, 'base64'))
          .digest('hex')
      }
    })),
    inspect: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'offline', message: 'Contact is unverifiable.' }
    })),
    result: vi.fn(),
    cancelled: vi.fn(),
    principal: async () => principal,
    sanitize: (value) => value.replaceAll('opaque-bearer-sentinel', '[redacted]')
  }
  const results = new Map<string, ConsoleLocalResult>()
  const journal: ConsoleResultJournal = {
    read: (dispatch) => results.get(dispatch) ?? null,
    record: vi.fn((record, result) => {
      results.set(record.worker.dispatch_id, result)
    }),
    flush: vi.fn(async () => {})
  }
  const service = new ConsoleLocalExecution(runtime, port, journal)
  return { directory, cwd, db, runtime, service, job, port, journal, exitGate }
}
