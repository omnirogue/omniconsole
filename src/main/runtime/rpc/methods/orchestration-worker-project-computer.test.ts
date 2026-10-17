import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { emptyProjectSettings, type ProjectHostPolicy } from '../../../../shared/project-settings'
import {
  chooseProjectComputer,
  withComputerNotes,
  type ProjectComputerRuntime
} from './orchestration-worker-project-computer'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

const PAIRED: Record<string, string> = { 'env-studio': 'Mac Studio' }

function runtime(
  hostPolicy: ProjectHostPolicy,
  here: ExecutionHostId = 'local'
): ProjectComputerRuntime {
  return {
    requestSessionFolders: async () => ({
      folder: { id: 'project-1', name: 'Ads', path: 'Ads' },
      project: {
        folderId: 'project-1',
        name: 'Ads',
        path: 'Ads',
        settings: { ...emptyProjectSettings(1), hostPolicy }
      }
    }),
    showTerminal: async () => ({ executionHostId: here }),
    resolveOrchestrationWorkerServer: (selector) => {
      const name = PAIRED[selector]
      if (!name) {
        throw new Error(`No saved environment ${selector}`)
      }
      return { environmentId: selector, name, peerFingerprint: 'peer' }
    }
  }
}

const movable = {
  task: 'task_1',
  from: 'term_coord',
  worktree: 'new-top-level',
  name: 'fix-login',
  repo: 'omni-ide'
} as WorkerStartInput

describe('chooseProjectComputer', () => {
  it('sends a movable worker to the first paired computer listed', async () => {
    const choice = await chooseProjectComputer(
      runtime(['runtime:env-studio', 'local']),
      movable,
      'project-1'
    )
    expect(choice).toEqual({
      on: 'env-studio',
      notes: ["Runs on Mac Studio, the first of “Ads”'s computers."]
    })
  })

  it("keeps today's start when the coordinator's own computer comes first", async () => {
    const choice = await chooseProjectComputer(
      runtime(['local', 'runtime:env-studio']),
      movable,
      'project-1'
    )
    expect(choice).toEqual({ notes: [] })
  })

  it('passes over computers worker-start cannot reach and says so', async () => {
    const choice = await chooseProjectComputer(
      runtime(['ssh:box', 'runtime:env-gone', 'runtime:env-studio']),
      movable,
      'project-1'
    )
    expect(choice.on).toBe('env-studio')
    expect(choice.notes[1]).toBe(
      "Passed over box, env-gone: worker-start can't reach it from here."
    )
  })

  it('leaves a worker bound to this computer here and says how to move it', async () => {
    const choice = await chooseProjectComputer(
      runtime(['runtime:env-studio']),
      { ...movable, worktree: 'current', name: undefined, repo: undefined },
      'project-1'
    )
    expect(choice.on).toBeUndefined()
    expect(choice.notes[0]).toContain('Pass --on Mac Studio')
  })

  it('runs here when no listed computer can take the worker', async () => {
    const choice = await chooseProjectComputer(runtime(['ssh:box']), movable, 'project-1')
    expect(choice).toEqual({
      notes: ["None of “Ads”'s computers can take this worker, so it runs here."]
    })
  })

  it('changes nothing for --on, no project, or a project without a list', async () => {
    const listed = runtime(['runtime:env-studio'])
    expect(await chooseProjectComputer(listed, { ...movable, on: 'other' }, 'project-1')).toEqual({
      notes: []
    })
    expect(await chooseProjectComputer(listed, movable, null)).toEqual({ notes: [] })
    expect(await chooseProjectComputer(runtime('auto'), movable, 'project-1')).toEqual({
      notes: []
    })
  })

  it('changes nothing when the window cannot read the project', async () => {
    const unread = {
      ...runtime(['runtime:env-studio']),
      requestSessionFolders: async () => {
        throw new Error('No OmniConsole window')
      }
    }
    expect(await chooseProjectComputer(unread, movable, 'project-1')).toEqual({ notes: [] })
  })
})

describe('withComputerNotes', () => {
  it("adds the notes to the project's lines", () => {
    const inherited = {
      brief: 'Project: Ads',
      receipt: { project: { folderId: 'project-1', name: 'Ads', notOnHost: [], notes: ['a'] } }
    }
    expect(withComputerNotes(inherited, ['b']).receipt.project).toEqual({
      folderId: 'project-1',
      name: 'Ads',
      notOnHost: [],
      notes: ['a', 'b']
    })
  })

  it('folds the notes into a project that was not inherited, and leaves none alone', () => {
    expect(
      withComputerNotes({ receipt: { project: { notInherited: 'No window.' } } }, ['b']).receipt
    ).toEqual({ project: { notInherited: 'No window. b' } })
    const none = { receipt: {} }
    expect(withComputerNotes(none, ['b'])).toBe(none)
  })
})
