import { describe, expect, it, vi } from 'vitest'
import {
  consoleLaunchAuthorizesTask,
  consumeConsoleLaunchAuthority,
  hasConsoleLaunchAuthority,
  mintConsoleLaunchGate,
  revalidateConsoleLaunchAuthority
} from './console-launch-authority'

const binding = { taskId: 'task-1', worktreeId: 'worktree-1', cwd: '/workspace/task-1' }
const taskEnv = { OMNI_TASK_ID: binding.taskId }

describe('Console launch authority', () => {
  it('does not transfer authority through a structurally identical or serialized gate', () => {
    const gate = mintConsoleLaunchGate({
      ...binding,
      validate: async () => undefined,
      assertCurrent: () => undefined
    })

    expect(hasConsoleLaunchAuthority(gate)).toBe(true)
    expect(consoleLaunchAuthorizesTask(gate, [binding.taskId], binding.worktreeId)).toBe(true)
    for (const copy of [{ ...gate }, JSON.parse(JSON.stringify(gate))]) {
      expect(copy).toEqual(gate)
      expect(hasConsoleLaunchAuthority(copy)).toBe(false)
      expect(consoleLaunchAuthorizesTask(copy, [binding.taskId], binding.worktreeId)).toBe(false)
    }
  })

  it.each<{
    reason: string
    worktreeId: string | undefined
    cwd: string
    env: Record<string, string>
  }>([
    { reason: 'stripped task binding', worktreeId: binding.worktreeId, cwd: binding.cwd, env: {} },
    {
      reason: 'padded task binding',
      worktreeId: binding.worktreeId,
      cwd: binding.cwd,
      env: { OMNI_TASK_ID: ` ${binding.taskId} ` }
    },
    {
      reason: 'changed task',
      worktreeId: binding.worktreeId,
      cwd: binding.cwd,
      env: { OMNI_TASK_ID: 'task-2' }
    },
    { reason: 'stripped worktree', worktreeId: undefined, cwd: binding.cwd, env: taskEnv },
    { reason: 'changed worktree', worktreeId: 'worktree-2', cwd: binding.cwd, env: taskEnv },
    {
      reason: 'changed working directory',
      worktreeId: binding.worktreeId,
      cwd: '/workspace/task-2',
      env: taskEnv
    }
  ])('rejects $reason before revalidating the principal', async ({ worktreeId, cwd, env }) => {
    const validate = vi.fn(async () => undefined)
    const gate = mintConsoleLaunchGate({ ...binding, validate, assertCurrent: () => undefined })

    await expect(revalidateConsoleLaunchAuthority(gate, worktreeId, cwd, env)).rejects.toThrow(
      'console_launch_authority_mismatch'
    )
    expect(validate).not.toHaveBeenCalled()
  })

  it('checks current principal authority again after an earlier successful preflight', async () => {
    const validate = vi.fn(async () => undefined)
    const gate = mintConsoleLaunchGate({ ...binding, validate, assertCurrent: () => undefined })

    await revalidateConsoleLaunchAuthority(gate, binding.worktreeId, `${binding.cwd}/`, taskEnv)
    const revocation = new Error('console_execution_principal_revoked')
    validate.mockRejectedValueOnce(revocation)

    await expect(
      revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv)
    ).rejects.toBe(revocation)
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('rejects an account change after successful validation without consuming the grant', async () => {
    let currentPerson = 'person-1'
    const personAtIssuance = currentPerson
    const assertCurrent = vi.fn(() => {
      if (currentPerson !== personAtIssuance) {
        throw new Error('console_execution_principal_changed')
      }
    })
    const validate = vi.fn(async () => {
      expect(currentPerson).toBe(personAtIssuance)
    })
    const gate = mintConsoleLaunchGate({ ...binding, validate, assertCurrent })
    await revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv)
    expect(validate).toHaveBeenCalledOnce()
    expect(assertCurrent).not.toHaveBeenCalled()

    currentPerson = 'person-2'

    expect(() => consumeConsoleLaunchAuthority(gate)).toThrow('console_execution_principal_changed')
    expect(assertCurrent).toHaveBeenCalledOnce()
    expect(hasConsoleLaunchAuthority(gate)).toBe(true)
    expect(() => consumeConsoleLaunchAuthority(gate)).toThrow('console_execution_principal_changed')
  })

  it('rejects a concurrent preflight when another launch consumes the gate while it waits', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstValidation = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondValidation = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const validate = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstValidation)
      .mockReturnValueOnce(secondValidation)
    const gate = mintConsoleLaunchGate({ ...binding, validate, assertCurrent: () => undefined })

    const first = revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv)
    const second = revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv)
    const secondRejected = expect(second).rejects.toThrow('console_launch_authority_consumed')

    releaseFirst()
    await first
    consumeConsoleLaunchAuthority(gate)
    releaseSecond()
    await secondRejected
    expect(validate).toHaveBeenCalledTimes(2)
    expect(hasConsoleLaunchAuthority(gate)).toBe(false)
  })

  it('permits only one start even when two preflights have already completed', async () => {
    const gate = mintConsoleLaunchGate({
      ...binding,
      validate: async () => undefined,
      assertCurrent: () => undefined
    })
    await Promise.all([
      revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv),
      revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv)
    ])

    consumeConsoleLaunchAuthority(gate)

    expect(() => consumeConsoleLaunchAuthority(gate)).toThrow('console_launch_authority_consumed')
    expect(consoleLaunchAuthorizesTask(gate, [binding.taskId], binding.worktreeId)).toBe(false)
    await expect(
      revalidateConsoleLaunchAuthority(gate, binding.worktreeId, binding.cwd, taskEnv)
    ).rejects.toThrow('console_launch_authority_mismatch')
  })

  it('leaves ordinary unbound native launches unchanged', async () => {
    await expect(
      revalidateConsoleLaunchAuthority(undefined, undefined, '/ordinary-workspace', {})
    ).resolves.toBeUndefined()
    expect(() => consumeConsoleLaunchAuthority(undefined)).not.toThrow()
  })
})
