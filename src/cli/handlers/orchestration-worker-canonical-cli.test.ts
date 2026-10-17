import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { ORCHESTRATION_CANONICAL_START_BARRIER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const prepareFlags = () =>
  new Map<string, string | boolean>([
    ['task', 'task_1'],
    ['run', 'run_1'],
    ['from', 'term_coord'],
    ['worktree', 'id:folder_1'],
    ['execution-file', '/runtime only/execution.json'],
    ['retry-request', 'prepare_request_1']
  ])

const executeFlags = () =>
  new Map<string, string | boolean>([
    ['dispatch', 'ctx_1'],
    ['start-receipt-file', '/runtime only/start-receipt.json'],
    ['retry-request', 'execute_request_1']
  ])

const invoke = (command: 'worker-prepare' | 'worker-execute', flags = prepareFlags()) =>
  ORCHESTRATION_HANDLERS[`orchestration ${command}`]({
    flags,
    client: { call: callMock },
    cwd: '/client only',
    json: true
  } as never)

function allowCanonicalStarts(): void {
  callMock.mockResolvedValueOnce({
    result: { capabilities: [ORCHESTRATION_CANONICAL_START_BARRIER_RUNTIME_CAPABILITY] }
  })
}

describe('canonical worker CLI boundary', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it.each(['worker-prepare', 'worker-execute'] as const)(
    '%s refuses an older runtime before any mutation',
    async (command) => {
      callMock.mockResolvedValueOnce({ result: {} })

      await expect(
        invoke(command, command === 'worker-prepare' ? prepareFlags() : executeFlags())
      ).rejects.toMatchObject({ code: 'incompatible_runtime' })

      expect(callMock).toHaveBeenCalledExactlyOnceWith('status.get')
      expect(printResult).not.toHaveBeenCalled()
    }
  )

  it('prepares with the host file path and preserves canonical proof while starting', async () => {
    const response = {
      result: {
        runId: 'run_1',
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'starting',
        stage: 'prepared',
        effects: [],
        residualResources: [],
        canonical: {
          binding: { executionId: 'exec_1' },
          processIdentity: { pid: 123, birth: 'birth_1' },
          phase: 'prepared',
          terminalProof: { paneKey: 'tab_1:leaf_1', processIncarnation: 'pty_1:inc_1' }
        }
      }
    }
    allowCanonicalStarts()
    callMock.mockResolvedValueOnce(response)

    await invoke('worker-prepare')

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerPrepare',
      {
        task: 'task_1',
        run: 'run_1',
        from: 'term_coord',
        worktree: 'id:folder_1',
        executionFile: '/runtime only/execution.json'
      },
      { orchestrationRequestId: 'prepare_request_1' }
    )
    expect(process.exitCode).toBeUndefined()
    expect(printResult).toHaveBeenCalledWith(response, true, expect.any(Function))
  })

  it('executes with the host receipt path and its own retry identity', async () => {
    allowCanonicalStarts()
    callMock.mockResolvedValueOnce({ result: { state: 'ready' } })

    await invoke('worker-execute', executeFlags())

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerExecute',
      { dispatch: 'ctx_1', startReceiptFile: '/runtime only/start-receipt.json' },
      { orchestrationRequestId: 'execute_request_1' }
    )
    expect(process.exitCode).toBeUndefined()
  })

  it.each([
    ['worker-prepare', 'failed'],
    ['worker-prepare', 'outcome_unknown'],
    ['worker-execute', 'starting'],
    ['worker-execute', 'failed'],
    ['worker-execute', 'outcome_unknown']
  ] as const)('%s reports %s as unsuccessful', async (command, state) => {
    allowCanonicalStarts()
    callMock.mockResolvedValueOnce({ result: { state } })

    await invoke(command, command === 'worker-prepare' ? prepareFlags() : executeFlags())

    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['worker-prepare', 'execution-file'],
    ['worker-execute', 'start-receipt-file']
  ] as const)('%s requires its host file path before mutation', async (command, flag) => {
    allowCanonicalStarts()
    const flags = command === 'worker-prepare' ? prepareFlags() : executeFlags()
    flags.delete(flag)

    await expect(invoke(command, flags)).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(callMock).toHaveBeenCalledExactlyOnceWith('status.get')
  })
})
