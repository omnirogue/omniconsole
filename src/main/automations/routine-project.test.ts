import { describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { SessionProjectLaunch } from '../../shared/session-project-cli'
import {
  createRoutineRunFiling,
  routineProjectBrief,
  type RoutineProjectDeps
} from './routine-project'

const routine = (fields: Partial<Automation> = {}) =>
  ({
    id: 'auto-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    sessionFolder: 'project-1',
    ...fields
  }) as Automation

const launch: SessionProjectLaunch = {
  project: { folderId: 'project-1', name: 'Ads' },
  projectLine: 'Project: Ads',
  host: { id: 'local', label: 'Local Mac' },
  attachments: [{ id: 'i', kind: 'instructions', title: 'Rules', content: 'Ship small' }],
  inherited: [],
  notOnHost: [],
  agent: null,
  error: null
}

function deps(overrides: Partial<RoutineProjectDeps> = {}) {
  const requests: SessionFolderRelayRequest[] = []
  const value: RoutineProjectDeps = {
    resolveLaunch: vi.fn(async () => launch),
    filing: vi.fn(async (request: SessionFolderRelayRequest) => {
      requests.push(request)
      return { sessionKey: 'key-1' }
    }),
    readAutomation: () => routine(),
    warn: vi.fn(),
    ...overrides
  }
  return { value, requests }
}

describe('routineProjectBrief', () => {
  it("resolves the project's brief for the computer the routine runs on", async () => {
    const { value } = deps()
    const brief = await routineProjectBrief(
      value,
      routine({ executionTargetType: 'ssh', executionTargetId: 'box', agentTemplateId: 'reviewer' })
    )
    expect(value.resolveLaunch).toHaveBeenCalledWith({
      folder: 'project-1',
      host: 'ssh:box',
      templateId: 'reviewer'
    })
    expect(brief).toContain('Ads')
    expect(brief).toContain('Ship small')
  })

  it('gives no brief outside a project, or when the project cannot be read', async () => {
    const { value } = deps({
      resolveLaunch: vi.fn(async () => {
        throw new Error('No OmniConsole window')
      })
    })
    expect(await routineProjectBrief(value, routine({ sessionFolder: undefined }))).toBeNull()
    expect(value.resolveLaunch).not.toHaveBeenCalled()
    expect(await routineProjectBrief(value, routine())).toBeNull()
    expect(value.warn).toHaveBeenCalled()
  })
})

describe('createRoutineRunFiling', () => {
  const run = (fields: Partial<AutomationRun> = {}) =>
    ({
      id: 'run-1',
      automationId: 'auto-1',
      status: 'dispatched',
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'tab-1:leaf-1',
      ...fields
    }) as AutomationRun

  it("files a dispatched run's session in its project once", async () => {
    const { value, requests } = deps()
    const file = createRoutineRunFiling(value)
    await file(run({ status: 'dispatching', terminalSessionId: null, terminalPaneKey: null }))
    await file(run())
    await file(run())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      kind: 'mutate',
      op: {
        kind: 'moveSession',
        tabId: 'tab-1',
        paneKey: 'tab-1:leaf-1',
        destination: 'folder',
        folder: 'project-1'
      }
    })
  })

  it('leaves runs of a routine in no project alone, and never fails a run it cannot file', async () => {
    const outside = deps({ readAutomation: () => routine({ sessionFolder: undefined }) })
    await createRoutineRunFiling(outside.value)(run())
    expect(outside.requests).toEqual([])
    const failing = deps({
      filing: vi.fn(async () => {
        throw new Error('No OmniConsole window')
      })
    })
    await expect(createRoutineRunFiling(failing.value)(run())).resolves.toBeUndefined()
    expect(failing.value.warn).toHaveBeenCalledWith(expect.stringContaining('not filed'))
  })
})
