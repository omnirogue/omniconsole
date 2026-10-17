import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { OrchestrationDb } from '../orchestration/db'
import type { OrcaRuntimeService } from '../omni-runtime'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowExecutionOutcome } from './workflow-execution-service'
import { WorkflowLiveRegistry } from './workflow-live-registry'
import { captureWorkflowOwner } from './workflow-owner-claim'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { LocalWorkflowHost } from './local-workflow-host'
import { projectLocalWorkflow } from './local-workflow-projection'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import { workflowCallDigest } from './workflow-call-digest'
import { WorkflowNoLaunchError } from './workflow-durable-call'
import { createWorkflowProgramContext, type WorkflowProgramCall } from './workflow-program-context'
import { runCouncilProgram } from './presets/council'
import { WORKFLOW_INTERRUPTED_ERROR } from './workflow-checkpoint-process'

type FakeWorking = {
  claims: string[]
  progress?: (id: string, event: { phase?: string }) => void
  finish: (outcome: WorkflowExecutionOutcome) => void
}

// The working-agent service (PR #539) is replaced by a stand-in whose run only ends when the test
// says so, so these tests see exactly what the host does while a recovered run is still working.
const fakes = vi.hoisted(() => ({ services: [] as FakeWorking[] }))
vi.mock('./working-workflow-execution-service', () => ({
  WorkingWorkflowExecutionService: class {
    readonly claims: string[] = []
    private readonly active = new Set<string>()
    finish!: (outcome: WorkflowExecutionOutcome) => void
    private readonly done = new Promise<WorkflowExecutionOutcome>((resolve) => {
      this.finish = resolve
    })

    constructor(readonly options: { progress?: FakeWorking['progress'] }) {
      fakes.services.push(this)
    }

    isActive(id: string): boolean {
      return this.active.has(id)
    }

    async resumeInterrupted(id: string, fence: number): Promise<number> {
      this.claims.push(id)
      this.active.add(id)
      this.options.progress?.(id, { phase: 'Answers' })
      return fence + 1
    }

    async recoverInterrupted(): Promise<never> {
      throw new Error('Recovery must not wait for the whole working run')
    }

    wait(id: string): Promise<WorkflowExecutionOutcome> {
      return this.done.then((outcome) => {
        this.active.delete(id)
        return outcome
      })
    }
  }
}))
vi.mock('../build-review/build-review-rpc-call', () => ({
  createOrchestrationCaller: () => async () => {
    throw new Error('Orchestration is not part of this test')
  }
}))

const opened: OrchestrationDb[] = []
const scratch: string[] = []
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  scratch.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  fakes.services.splice(0)
  vi.restoreAllMocks()
})

const address = (executionId: string) => ({
  worktree: 'workspace-a',
  conversationId: 'conversation-a',
  executionId
})

async function restartedHost(snapshot: Record<string, unknown>) {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const owner = await captureWorkflowOwner('test-host')
  const executionId = new WorkflowCheckpointStore(db.db).create({
    conversationId: JSON.stringify(['workspace-a', 'conversation-a']),
    requestId: 'request-1',
    owner,
    snapshot: {
      version: 1,
      task: { prompt: 'Question', evidence: '' },
      seats: [],
      synthesizerId: 'seat-1',
      ...snapshot
    },
    preset: 'council',
    fence: 1,
    attemptLimit: 1,
    callLimit: 7,
    budgetLimit: 7
  })
  const host = new LocalWorkflowHost({
    db: db.db,
    owner,
    slots: new WorkflowScriptSlots(2),
    resolve: async ({ worktree }) => ({ id: worktree, path: '/workspace', label: worktree }),
    catalog: async () => [],
    listScope: async () => [],
    freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
    attestNativeResult: () => {},
    launch: () => async () => {
      throw new Error('No provider launches in this test')
    },
    working: { db, runtime: {} as OrcaRuntimeService }
  })
  return { db, host, executionId }
}

describe('local workflow host recovery after a restart', () => {
  it('watches a working run as soon as it is claimed again, and finishes it when it ends', async () => {
    const finish = vi.spyOn(WorkflowLiveRegistry.prototype, 'finish')
    const { host, executionId } = await restartedHost({
      capability: { mode: 'working-agent', revision: 1 },
      councilProgramRevision: 5
    })
    const views: LocalWorkflowView[] = []
    // Resolves while the working program still runs: nothing waits for the whole run.
    const stop = await host.watch(address(executionId), (view) => views.push(view))
    await vi.waitFor(() => expect(views.length).toBeGreaterThan(0))
    const [service] = fakes.services
    expect(service.claims).toEqual([executionId])
    // Opening the tab again neither claims the run twice nor waits.
    const again = await host.watch(address(executionId), () => {})
    again()
    expect(service.claims).toEqual([executionId])
    expect(finish).not.toHaveBeenCalledWith(executionId)

    service.finish({ state: 'completed', result: { markdown: 'Final' } })
    // The recovered run's live entry joins the finished list, so it is evicted like any other.
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(executionId))
    stop()
  })

  it('shows a run an earlier version recorded as stopped, keeping its question', async () => {
    // Why: live acceptance found such runs as "Needs you · 0 agents" with the question replaced
    // by "Workflow evidence requires recovery." and nothing the person could do about it.
    const { db, host, executionId } = await restartedHost({ host: { startedAt: 1234 } })
    db.db
      .prepare("UPDATE local_workflow_executions SET state='recovery_failed' WHERE id=?")
      .run(executionId)
    expect(await host.status(address(executionId))).toMatchObject({
      conversationId: 'conversation-a',
      executionId,
      state: 'cancelled'
    })
    expect(await host.show(address(executionId))).toMatchObject({
      executionId,
      preset: 'council',
      state: 'cancelled',
      prompt: 'Question',
      startedAt: 1234,
      actions: [],
      calls: [],
      unreadable: 'earlier-version',
      error: 'Workflow recovery is blocked'
    })
  })

  it('keeps no question from a snapshot that fails its digest, and every reason', async () => {
    const { db, executionId } = await restartedHost({})
    db.db
      .prepare(
        "UPDATE local_workflow_executions SET state='recovery_failed',snapshot_digest='x' WHERE id=?"
      )
      .run(executionId)
    const view = projectLocalWorkflow({
      db: db.db,
      store: new WorkflowCheckpointStore(db.db),
      executionId,
      active: false,
      outcome: { state: 'recovery_required', error: 'Workflow call identity changed' }
    })
    // A snapshot that fails its digest is damaged, not the work of an earlier version.
    expect(view).toMatchObject({
      state: 'cancelled',
      prompt: '',
      startedAt: 0,
      unreadable: 'damaged'
    })
    expect(view.error).toBe('Workflow recovery is blocked\nWorkflow call identity changed')
  })

  it.skipIf(process.platform === 'win32')(
    'opens a run whose agents died in a restart as Paused, and Resume asks them again',
    async () => {
      // Why: an update restarted OmniConsole mid-Discover; the run reopened as "Needs you" listing
      // `ENOENT … terminal.json` for every agent that had been working, with nothing to press.
      const db = new OrchestrationDb(':memory:')
      opened.push(db)
      const directory = mkdtempSync(join(tmpdir(), 'workflow-host-interrupted-'))
      scratch.push(directory)
      const seats = ['claude', 'codex', 'grok'].map((agent, index) => ({
        id: agent,
        agent: agent as 'claude' | 'codex' | 'grok',
        accountId: `account-${index}`,
        model: `${agent}-model`,
        effort: null,
        lineage: (['anthropic', 'openai', 'xai'] as const)[index],
        policyRevision: 'test'
      }))
      const task = { prompt: 'Question', evidence: '' }
      const asked: WorkflowProgramCall[] = []
      await runCouncilProgram(
        createWorkflowProgramContext({
          agent: async (call) => {
            asked.push(call)
            throw new Error('collected')
          },
          guard: () => {},
          phase: () => {},
          log: () => {},
          isFatal: () => false
        }),
        { panel: seats, synthesizerId: 'claude', revision: 4 },
        task
      ).catch(() => {})
      const call = asked.find((entry) => entry.id === 'answers/claude')!
      const previous = {
        hostId: 'test-host',
        pid: 987654,
        processStartTimeMs: 1,
        spawnToken: 'old'
      }
      const store = new WorkflowCheckpointStore(db.db)
      const executionId = store.create({
        conversationId: JSON.stringify(['workspace-a', 'conversation-a']),
        requestId: 'request-1',
        owner: previous,
        snapshot: {
          version: 1,
          task,
          seats,
          synthesizerId: 'claude',
          councilProgramRevision: 4,
          host: { startedAt: 1234 }
        },
        preset: 'council',
        fence: 1,
        attemptLimit: 3,
        callLimit: 7,
        budgetLimit: 7
      })
      const prepared = store.prepare({
        executionId,
        fence: 1,
        callId: call.id,
        inputDigest: workflowCallDigest(call, JSON.stringify(seats[0]), 'claude'),
        reservation: 1,
        validate: () => {}
      })
      if (!('attemptId' in prepared)) {
        throw new Error('Expected attempt')
      }
      await createWorkflowLocalProcessLaunch({
        directory,
        executionId,
        fence: 1,
        hostId: previous.hostId,
        ownerIncarnation: previous.spawnToken,
        timeoutMs: 5000,
        maxOutputBytes: 4096,
        command: () => ({ program: process.execPath, args: ['-e', ''], input: call.prompt })
      })({
        ...prepared,
        call,
        problems: null,
        signal: new AbortController().signal,
        recordPreparation: (identity) =>
          store.recordProcessPreparation(prepared.attemptId, 1, identity),
        recordLaunch: (ref) => store.recordLaunch(prepared.attemptId, 1, ref),
        recordNoLaunch: (reason) => store.recordNoLaunch(prepared.attemptId, 1, reason)
      })
      // The old owner died before it recorded the agent's exit.
      rmSync(join(directory, prepared.attemptId, 'terminal.json'))

      const launched: { callId: string; ordinal: number }[] = []
      const host = new LocalWorkflowHost({
        db: db.db,
        owner: await captureWorkflowOwner('test-host'),
        slots: new WorkflowScriptSlots(2),
        resolve: async ({ worktree }) => ({ id: worktree, path: '/workspace', label: worktree }),
        catalog: async () => [],
        listScope: async () => [],
        freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
        attestNativeResult: () => {},
        launch: () => async (input) => {
          launched.push({ callId: input.call.id, ordinal: input.ordinal })
          input.recordNoLaunch('This test launches no provider')
          throw new WorkflowNoLaunchError('This test launches no provider')
        }
      })

      const view = await host.show(address(executionId))
      expect(view).toMatchObject({
        state: 'paused',
        fence: 2,
        actions: ['resume', 'stop'],
        error: '1 agent was interrupted when OmniConsole closed. Resume runs it again.'
      })
      expect(view.calls.find((entry) => entry.id === 'answers/claude')).toMatchObject({
        state: 'failed',
        error: WORKFLOW_INTERRUPTED_ERROR
      })
      expect(JSON.stringify(view)).not.toMatch(/ENOENT/)
      await expect(
        host.readCall({ ...address(executionId), callId: 'answers/claude' })
      ).resolves.toMatchObject({ stdout: '', stderr: '' })

      await host.control({ ...address(executionId), fence: view.fence, action: 'resume' })
      await vi.waitFor(() =>
        expect(launched).toContainEqual({ callId: 'answers/claude', ordinal: 2 })
      )
    }
  )
})
