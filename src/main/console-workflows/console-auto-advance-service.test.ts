import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consoleAutoAdvanceOff,
  type ConsoleAutoAdvancePreference,
  type ConsoleAutoAdvanceSetRequest
} from '../../shared/console-auto-advance'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleAutoAdvance } from './console-auto-advance'
import {
  clearConsoleAutoAdvanceRunnerSource,
  installConsoleAutoAdvanceRunnerSource
} from './console-auto-advance-registry'
import {
  getConsoleAutoAdvanceService,
  readConsoleAutoAdvance,
  writeConsoleAutoAdvance
} from './console-auto-advance-service'

const WORKFLOW_ID = 'wf_service_fixture'
const WORKTREE = 'id:wt_service_fixture'

function fakeRuntime(): {
  runtime: OrcaRuntimeService
  writes: ConsoleAutoAdvanceSetRequest[]
} {
  const writes: ConsoleAutoAdvanceSetRequest[] = []
  const runtime = {
    getConsoleAutoAdvance: (workflowId: string) => consoleAutoAdvanceOff(workflowId, WORKTREE),
    setConsoleAutoAdvance: (
      request: ConsoleAutoAdvanceSetRequest
    ): ConsoleAutoAdvancePreference => {
      writes.push(request)
      const preference = consoleAutoAdvanceOff(request.workflowId, request.worktree ?? WORKTREE)
      return { ...preference, enabled: request.enabled }
    }
  } as unknown as OrcaRuntimeService
  return { runtime, writes }
}

function fakeRunner(): { runner: ConsoleAutoAdvance; began: string[]; stopped: string[] } {
  const began: string[] = []
  const stopped: string[] = []
  const runner = {
    begin: (workflowId: string) => began.push(workflowId),
    stop: (workflowId: string) => stopped.push(workflowId)
  } as unknown as ConsoleAutoAdvance
  return { runner, began, stopped }
}

afterEach(() => {
  clearConsoleAutoAdvanceRunnerSource()
  vi.restoreAllMocks()
})

describe('console auto-advance service without an installed runner', () => {
  it('refuses to name a runner instead of importing one', () => {
    const { runtime } = fakeRuntime()
    expect(() => getConsoleAutoAdvanceService(runtime)).toThrow(/desktop session/i)
  })

  it('refuses to persist "on" on a host that cannot start a job', () => {
    const { runtime, writes } = fakeRuntime()
    expect(() =>
      writeConsoleAutoAdvance(runtime, { workflowId: WORKFLOW_ID, enabled: true })
    ).toThrow(/desktop session/i)
    expect(writes).toEqual([])
  })

  it('still turns auto-advance off', () => {
    const { runtime, writes } = fakeRuntime()
    const preference = writeConsoleAutoAdvance(runtime, {
      workflowId: WORKFLOW_ID,
      enabled: false
    })
    expect(preference.enabled).toBe(false)
    expect(writes).toHaveLength(1)
  })

  it('still reads the preference', () => {
    const { runtime } = fakeRuntime()
    expect(readConsoleAutoAdvance(runtime, WORKFLOW_ID).workflowId).toBe(WORKFLOW_ID)
  })
})

describe('console auto-advance service with an installed runner', () => {
  it('begins one cycle when the person turns it on', () => {
    const { runtime } = fakeRuntime()
    const { runner, began, stopped } = fakeRunner()
    installConsoleAutoAdvanceRunnerSource(() => runner)
    const preference = writeConsoleAutoAdvance(runtime, {
      workflowId: WORKFLOW_ID,
      enabled: true,
      worktree: WORKTREE
    })
    expect(preference.enabled).toBe(true)
    expect(began).toEqual([WORKFLOW_ID])
    expect(stopped).toEqual([])
  })

  it('stops the poll when the person turns it off', () => {
    const { runtime } = fakeRuntime()
    const { runner, began, stopped } = fakeRunner()
    installConsoleAutoAdvanceRunnerSource(() => runner)
    writeConsoleAutoAdvance(runtime, { workflowId: WORKFLOW_ID, enabled: false })
    expect(began).toEqual([])
    expect(stopped).toEqual([WORKFLOW_ID])
  })

  it('rejects an unadmitted workflow id before touching the runtime', () => {
    const { runtime, writes } = fakeRuntime()
    const { runner } = fakeRunner()
    installConsoleAutoAdvanceRunnerSource(() => runner)
    expect(() => writeConsoleAutoAdvance(runtime, { workflowId: 'nope', enabled: true })).toThrow(
      /admitted workflow/i
    )
    expect(writes).toEqual([])
  })
})
