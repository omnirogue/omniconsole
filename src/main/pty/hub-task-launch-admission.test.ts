import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertUnboundHubTerminalLaunch } from './hub-task-launch-admission'
import { consumeConsoleLaunchAuthority, mintConsoleLaunchGate } from './console-launch-authority'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

beforeEach(() => setPlatform('linux'))
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

describe('assertUnboundHubTerminalLaunch', () => {
  function mintGate() {
    return mintConsoleLaunchGate({
      taskId: 'task-1',
      worktreeId: 'worktree-1',
      cwd: '/workspace/task-1',
      validate: async () => undefined,
      assertCurrent: () => undefined
    })
  }

  it('admits matching task bindings only with the original main-process gate', () => {
    const launchGate = mintGate()
    const input = {
      hubTaskId: ' task-1 ',
      env: { OMNI_TASK_ID: 'task-1' },
      agentEnv: { OMNI_TASK_ID: 'task-1' },
      worktreeId: 'worktree-1',
      launchGate
    }

    expect(() => assertUnboundHubTerminalLaunch(input)).not.toThrow()
    for (const copy of [{ ...launchGate }, JSON.parse(JSON.stringify(launchGate))]) {
      expect(() => assertUnboundHubTerminalLaunch({ ...input, launchGate: copy })).toThrowError(
        expect.objectContaining({ code: 'consumer_fenced' })
      )
    }
    consumeConsoleLaunchAuthority(launchGate)
    expect(() => assertUnboundHubTerminalLaunch(input)).toThrowError(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
  })

  it.each([
    { source: 'explicit task', hubTaskId: 'task-2' },
    { source: 'environment', env: { OMNI_TASK_ID: 'task-2' } },
    { source: 'agent environment', agentEnv: { OMNI_TASK_ID: 'task-2' } },
    { source: 'worktree', worktreeId: 'worktree-2' }
  ])('fences a conflicting $source even beside matching bindings', (override) => {
    expect(() =>
      assertUnboundHubTerminalLaunch({
        hubTaskId: 'task-1',
        env: { OMNI_TASK_ID: 'task-1' },
        agentEnv: { OMNI_TASK_ID: 'task-1' },
        worktreeId: 'worktree-1',
        launchGate: mintGate(),
        ...override
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it.each(['env', 'agentEnv'] as const)(
    'fences a padded task ID in %s despite a valid gate and matching bindings',
    (source) => {
      expect(() =>
        assertUnboundHubTerminalLaunch({
          hubTaskId: 'task-1',
          env: { OMNI_TASK_ID: 'task-1' },
          agentEnv: { OMNI_TASK_ID: 'task-1' },
          worktreeId: 'worktree-1',
          launchGate: mintGate(),
          [source]: { OMNI_TASK_ID: ' task-1 ' }
        })
      ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    }
  )

  it('fences conflicting Windows key variants beside an authorized uppercase binding', () => {
    setPlatform('win32')

    expect(() =>
      assertUnboundHubTerminalLaunch({
        hubTaskId: 'task-1',
        env: { OMNI_TASK_ID: 'task-1', omni_task_id: 'task-2' },
        worktreeId: 'worktree-1',
        launchGate: mintGate()
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it.each(['linux', 'darwin', 'win32'] as const)(
    'fences an explicit Hub task on %s without environment bindings',
    (platform) => {
      setPlatform(platform)
      expect(() => assertUnboundHubTerminalLaunch({ hubTaskId: ' task-1 ', env: {} })).toThrowError(
        expect.objectContaining({ name: 'OrchestrationError', code: 'consumer_fenced' })
      )
    }
  )

  it.each(['env', 'agentEnv'] as const)('fences the exact task key in %s on POSIX', (source) => {
    expect(() =>
      assertUnboundHubTerminalLaunch({ [source]: { OMNI_TASK_ID: 'task-1' } })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it.each(['env', 'agentEnv'] as const)(
    'finds all Windows task-key variants in %s even beside an empty uppercase key',
    (source) => {
      setPlatform('win32')
      for (const key of ['omni_task_id', 'Omni_Task_Id', 'oMnI_tAsK_iD']) {
        expect(() =>
          assertUnboundHubTerminalLaunch({
            [source]: { OMNI_TASK_ID: ' ', [key]: 'task-1' }
          })
        ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
      }
    }
  )

  it.each(['linux', 'darwin'] as const)(
    'keeps environment keys case-sensitive on %s',
    (platform) => {
      setPlatform(platform)
      expect(() =>
        assertUnboundHubTerminalLaunch({
          env: { OMNI_TASK_ID: '', omni_task_id: 'ordinary-variable' },
          agentEnv: { Omni_Task_Id: 'another-variable' }
        })
      ).not.toThrow()
    }
  )

  it.each(['linux', 'darwin', 'win32'] as const)(
    'allows unbound and blank inputs on %s',
    (platform) => {
      setPlatform(platform)
      expect(() => assertUnboundHubTerminalLaunch({})).not.toThrow()
      expect(() =>
        assertUnboundHubTerminalLaunch({
          hubTaskId: ' \t ',
          env: { OMNI_TASK_ID: '', Omni_Task_Id: '\t', TERM: 'xterm-256color' },
          agentEnv: { OMNI_TASK_ID: ' \n' }
        })
      ).not.toThrow()
    }
  )

  it.each(['linux', 'win32'] as const)(
    'allows unset process-environment values on %s',
    (platform) => {
      setPlatform(platform)
      const env: NodeJS.ProcessEnv = { OMNI_TASK_ID: undefined, Omni_Task_Id: undefined }

      expect(() =>
        assertUnboundHubTerminalLaunch({
          env: env as Record<string, string>,
          agentEnv: env as Record<string, string>
        })
      ).not.toThrow()
    }
  )
})
