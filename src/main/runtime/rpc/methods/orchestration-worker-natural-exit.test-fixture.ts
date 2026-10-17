import { vi, type Mock } from 'vitest'
import type { PtyLaunchGateReceipt } from '../../../../shared/pty-launch-gate'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import type { TerminalExitCause } from '../../../../shared/terminal-exit-cause'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import {
  requestWorkerNaturalExit,
  type WorkerNaturalExitObservation,
  type WorkerNaturalExitRuntime,
  type WorkerNaturalExitResult
} from './orchestration-worker-natural-exit'

type WorkerNaturalExitFixture = {
  gate: PtyLaunchGateReceipt
  resource: WorkerTerminalResourceRow
  worker: { state: string; agent_terminal_handle: string }
  state: { observation: WorkerNaturalExitObservation | null }
  db: Record<
    | 'getDispatchContextById'
    | 'getFederatedDispatch'
    | 'getWorkerTerminalResourceByOwner'
    | 'getWorkerDispatch'
    | 'isDispatchProcessCurrent'
    | 'workerTerminalResourceHasIdentityConflict',
    Mock
  >
  runtime: Record<
    | 'getTerminalPaneKey'
    | 'getTerminalProcessIncarnation'
    | 'getOrchestrationDispatchAuthority'
    | 'waitForTerminal'
    | 'sendTerminal'
    | 'closeTerminal',
    Mock
  >
  observeProcess: Mock<() => Promise<WorkerNaturalExitObservation | null>>
  exit: (exitCode?: number, exitCause?: TerminalExitCause) => RuntimeTerminalWait
  run: () => Promise<WorkerNaturalExitResult>
}

export function createWorkerNaturalExitFixture(): WorkerNaturalExitFixture {
  const gate: PtyLaunchGateReceipt = {
    version: 1,
    state: 'closed',
    launchId: 'launch-1',
    gateId: 'gate-1',
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    pid: 42,
    processStartTimeMs: 1_780_000_000_000,
    processKind: 'pty-root',
    reportsChildExitStatus: true,
    startupCommandMode: 'exec'
  }
  const hostScope = { kind: 'local', hostId: 'local' } as const
  const resource = {
    id: 'resource-1',
    owner_dispatch_id: 'dispatch-1',
    terminal_handle: 'term-1',
    pane_key: 'tab-1:leaf-1',
    process_incarnation: 'pty-1:inc-1',
    host_scope: JSON.stringify(hostScope),
    ownership_state: 'owned',
    release_state: 'not_requested'
  } as WorkerTerminalResourceRow
  const worker = { state: 'succeeded', agent_terminal_handle: 'term-1' }
  const state: { observation: WorkerNaturalExitObservation | null } = {
    observation: {
      gate: { ...gate },
      hostScope,
      status: 'live',
      agent: 'claude',
      launchGateReleased: true
    }
  }
  const db = {
    getDispatchContextById: vi.fn(() => null),
    getFederatedDispatch: vi.fn(() => null),
    getWorkerTerminalResourceByOwner: vi.fn(() => resource),
    getWorkerDispatch: vi.fn(() => worker),
    isDispatchProcessCurrent: vi.fn(
      (p) =>
        p.dispatchId === 'dispatch-1' &&
        p.paneKey === resource.pane_key &&
        p.processIncarnation === resource.process_incarnation
    ),
    workerTerminalResourceHasIdentityConflict: vi.fn(() => false)
  }
  const exit = (
    exitCode = 0,
    exitCause: TerminalExitCause | undefined = { kind: 'exited', exitCode }
  ) => {
    state.observation = {
      ...state.observation!,
      status: 'exited',
      exit: {
        observedAt: '2026-09-08T22:00:00.000Z',
        providerExitObserved: true,
        wait: {
          handle: 'term-1',
          condition: 'exit',
          status: 'exited',
          satisfied: true,
          exitCode,
          exitCause
        }
      }
    }
    return state.observation.exit!.wait
  }
  const runtime = {
    getTerminalPaneKey: vi.fn(() => resource.pane_key),
    getTerminalProcessIncarnation: vi.fn(() => resource.process_incarnation),
    getOrchestrationDispatchAuthority: vi.fn(() =>
      state.observation?.status === 'exited' ? null : { hostScope }
    ),
    waitForTerminal: vi.fn(async (_handle, options): Promise<RuntimeTerminalWait> =>
      options.condition === 'exit'
        ? exit()
        : {
            handle: 'term-1',
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          }
    ),
    sendTerminal: vi.fn(async (_handle, _action, options) => {
      await options.beforeWrite(gate.ptyId)
      options.reserveWrite(gate.ptyId)
      return { handle: 'term-1', accepted: true, bytesWritten: 6 }
    }),
    closeTerminal: vi.fn()
  }
  const observeProcess = vi.fn(async () => state.observation)
  const run = () =>
    requestWorkerNaturalExit({
      runtime: runtime as unknown as WorkerNaturalExitRuntime,
      db: db as unknown as OrchestrationDb,
      dispatchId: 'dispatch-1',
      gate,
      observeProcess,
      timeoutMs: 30
    })
  return { gate, resource, worker, state, db, runtime, observeProcess, exit, run }
}
