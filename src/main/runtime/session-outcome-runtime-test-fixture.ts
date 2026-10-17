import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { OrchestrationDb } from './orchestration/db'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { SessionChainPersistence } from '../persistence/loading-store/session-chain-persistence'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { writeFileDurableSync } from '../durable-file-write'

/** Real RPC dispatch/admission/database; substitutes only the external agent terminal boundary. */
export function outcomeRuntimeFixture(
  worker: (spec: string, workspace: string) => { body: string; outcome?: 'succeeded' | 'failed' },
  restoreFrom?: string
) {
  const workspace = restoreFrom ?? mkdtempSync(join(tmpdir(), 'outcome-runtime-'))
  const metadata = join(workspace, '.omni')
  mkdirSync(metadata, { recursive: true })
  const db = new OrchestrationDb(join(metadata, 'orchestration.sqlite'))
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  const state = (
    restoreFrom
      ? JSON.parse(readFileSync(join(metadata, 'state.json'), 'utf8'))
      : { sessionChains: [] }
  ) as PersistedState
  let databaseClosed = false
  const closeDatabase = () => {
    if (!databaseClosed) {
      db.close()
      databaseClosed = true
    }
  }
  const persistence = new SessionChainPersistence(
    {
      state,
      flushOrThrow: () =>
        writeFileDurableSync(
          join(metadata, 'state.tmp'),
          join(metadata, 'state.json'),
          JSON.stringify(state)
        )
    },
    {} as WriteSchedulingOperations
  )
  vi.spyOn(runtime, 'listSessionChains').mockImplementation(() => persistence.listSessionChains())
  vi.spyOn(runtime, 'replaceSessionChainOutcomesAndFlush').mockImplementation((chain, expected) =>
    persistence.replaceSessionChainOutcomesAndFlush(chain, expected)
  )
  vi.spyOn(runtime, 'getSessionOutcomeExecutionScope').mockResolvedValue({
    path: workspace,
    connectionId: null
  })
  vi.spyOn(runtime, 'hasDurableSessionOutcomeStore').mockReturnValue(true)
  runtime.setSessionOutcomeContinuationAvailable(true)
  const panes = new Map<string, string>()
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
    if (!panes.has(handle)) {
      panes.set(
        handle,
        `${handle}:aaaaaaaa-aaaa-4aaa-8aaa-${String(panes.size + 1).padStart(12, '0')}`
      )
    }
    return panes.get(handle)!
  })
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
    runtime.getTerminalPaneKey(handle)
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
    (handle) => `test:${handle}:1`
  )
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'folder:outcome',
    repoId: 'folder',
    path: workspace
  } as never)
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
    id: 'folder:outcome',
    repoId: 'folder',
    path: workspace
  } as never)
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({ terminals: [] } as never)
  let terminals = restoreFrom ? 1000 : 0
  vi.spyOn(runtime, 'createTerminal').mockImplementation(
    async () => ({ handle: `term_${++terminals}` }) as never
  )
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async (handle) =>
      ({ handle, worktreeId: 'folder:outcome', status: 'running', connected: true }) as never
  )
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({ ptyKilled: true } as never)
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('omni')
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  } as never)
  vi.spyOn(runtime, 'resolveTerminalPane').mockReturnValue({
    handle: 'source',
    connected: true,
    tabId: 'source',
    leafId: 'leaf',
    ptyId: 'pty'
  })
  vi.spyOn(runtime, 'getFreshAgentHookStatusForHandle').mockReturnValue({
    state: 'done',
    lastAssistantMessage: null,
    interactivePrompt: null,
    stateStartedAt: Date.now(),
    updatedAt: Date.now()
  })
  const reports: Promise<unknown>[] = [],
    launched: string[] = []
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, prompt) => {
    const dispatch = db.getActiveDispatchForTerminal(handle)!
    const spec =
      JSON.parse(db.getWorkerDispatch(dispatch.id)!.start_options).executionBrief ??
      db.getTask(dispatch.task_id)!.spec
    launched.push(spec)
    reports.push(
      new Promise((resolve) => setTimeout(resolve, 0)).then(async () => {
        const report = worker(spec, workspace)
        const send = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.send')!
        return send.handler(
          send.params!.parse({
            from: handle,
            type: 'worker_done',
            subject: 'Test result',
            body: report.body,
            payload: JSON.stringify({
              taskId: dispatch.task_id,
              dispatchId: dispatch.id,
              outcome: report.outcome ?? 'succeeded',
              filesModified: ''
            })
          }),
          { runtime, orchestrationCapability: /--dispatch-capability (\S+)/.exec(prompt)?.[1] }
        )
      })
    )
    return { handle, accepted: true, bytesWritten: prompt.length }
  })
  const service = runtime.getSessionOutcomeService()
  // A production tick returns while the worker's readiness wait runs on (WP-4a); a test asserts on
  // what that wait did, so the fixture's tick waits for the launches that tick started. `hostTick`
  // is the unwrapped one, for the tests that are about the tick not waiting.
  const hostTick = service.tick.bind(service)
  // The host's own cadence tick lands here too; queued, a test tick never becomes a lane-busy skip.
  let ticking: Promise<void> = Promise.resolve()
  let queued: Promise<void> | null = null
  vi.spyOn(service, 'tick').mockImplementation(() => {
    // Callers arriving before the queued tick starts share it: it still starts after each call.
    queued ??= ticking.then(async () => {
      queued = null
      await hostTick()
      await service.launches.settled()
    })
    ticking = queued.catch(() => {})
    return queued
  })
  return {
    runtime,
    db,
    service,
    hostTick,
    workspace,
    persistence,
    closeDatabase,
    launched,
    write: (name: string, content: string) => writeFileSync(join(workspace, name), content),
    settleReports: async () => {
      await Promise.all(reports.splice(0))
    },
    settle: async () => {
      await Promise.all(reports.splice(0))
      await service.tick()
    },
    dispose: async () => {
      await service.suspend()
      await Promise.allSettled(reports)
      closeDatabase()
      rmSync(workspace, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  }
}
