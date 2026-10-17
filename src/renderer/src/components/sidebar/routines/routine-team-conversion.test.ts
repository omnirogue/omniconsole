import type { Automation } from '../../../../../shared/automations-types'
import { expect, it, vi } from 'vitest'
import {
  convertRoutineToTeam,
  routineConversionBusy,
  routineTeamBody,
  type RoutineTeamLink
} from './routine-team-conversion'

it('waits for create, ignores a second click, then records the receipt before disabling', async () => {
  let finish!: (value: { id: string }) => void
  const create = vi.fn(
    () =>
      new Promise<{ id: string }>((resolve) => {
        finish = resolve
      })
  )
  const events: string[] = []
  const disable = vi.fn(async () => {
    events.push('disable')
  })
  const save = vi.fn(() => {
    events.push('save')
  })
  const enable = vi.fn(async () => {
    events.push('enable')
    return { status: 'active', next_due: '2026-09-19T09:00:00Z' }
  })
  const args = { id: 'a', create, enable, disable, save }
  const first = convertRoutineToTeam(args)
  expect(routineConversionBusy('a')).toBe(true)
  expect(disable).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  await convertRoutineToTeam(args)
  expect(create).toHaveBeenCalledTimes(1)
  finish({ id: 'rtn_new' })
  await first
  expect(events).toEqual(['save', 'enable', 'save', 'disable', 'save'])
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      teamRoutineId: 'rtn_new',
      state: 'linked',
      nextDue: '2026-09-19T09:00:00Z'
    })
  )
  expect(routineConversionBusy('a')).toBe(false)
})
it('has zero local mutations on create refusal', async () => {
  const disable = vi.fn()
  const enable = vi.fn()
  const save = vi.fn()
  await expect(
    convertRoutineToTeam({
      id: 'failed',
      enable,
      create: vi.fn().mockRejectedValue(new Error('Unknown department')),
      disable,
      save
    })
  ).rejects.toThrow('Unknown department')
  expect(disable).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(enable).not.toHaveBeenCalled()
})
it('preserves the hub ID and enabled local state when disable fails; retry only disables', async () => {
  let link: RoutineTeamLink | undefined
  let enabled = true
  const create = vi.fn().mockResolvedValue({ id: 'rtn_saved' })
  const enable = vi.fn().mockResolvedValue({ status: 'active' })
  const save = (next: RoutineTeamLink): void => {
    link = next
  }
  await expect(
    convertRoutineToTeam({
      id: 'retry',
      enable,
      create,
      save,
      disable: async () => {
        throw new Error('host unavailable')
      }
    })
  ).rejects.toThrow('host unavailable')
  expect(enabled).toBe(true)
  expect(link).toMatchObject({
    teamRoutineId: 'rtn_saved',
    state: 'enabled'
  })
  await convertRoutineToTeam({
    id: 'retry',
    enable,
    link,
    create,
    save,
    disable: async () => {
      enabled = false
    }
  })
  expect(create).toHaveBeenCalledTimes(1)
  expect(enabled).toBe(false)
  expect(enable).toHaveBeenCalledTimes(1)
  expect(link).toMatchObject({
    teamRoutineId: 'rtn_saved',
    state: 'linked'
  })
})
it('refuses an empty create receipt before touching local state', async () => {
  const disable = vi.fn(),
    save = vi.fn()
  await expect(
    convertRoutineToTeam({
      id: 'empty',
      enable: vi.fn(),
      create: async () => ({ id: '' }),
      disable,
      save
    })
  ).rejects.toThrow()
  expect(disable).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})

it('builds the exact disabled AI draft using the existing prompt/title convention', () => {
  expect(
    routineTeamBody(
      { name: 'Summary', prompt: 'Read activity' } as Automation,
      '0 14 * * *',
      'omnirogue/marketing'
    )
  ).toEqual({
    name: 'Summary',
    description: '',
    trigger_type: 'cron',
    trigger_config: { cron: '0 14 * * *' },
    task_template: { title: 'Summary', prompt: 'Read activity' },
    status: 'disabled',
    scope: 'omnirogue/marketing',
    purpose: 'ai'
  })
})

it('persists pending enable and resumes on the same ID without creating again', async () => {
  let link: RoutineTeamLink | undefined
  const create = vi.fn().mockResolvedValue({ id: 'rtn_pending' })
  const enable = vi
    .fn()
    .mockRejectedValueOnce(new Error('Proof of life required'))
    .mockResolvedValue({ status: 'active' })
  const disable = vi.fn()
  const args = {
    id: 'pending',
    create,
    enable,
    disable,
    save: (next: RoutineTeamLink) => {
      link = next
    }
  }
  await expect(convertRoutineToTeam(args)).rejects.toThrow('Proof of life required')
  expect(disable).not.toHaveBeenCalled()
  expect(link).toMatchObject({
    teamRoutineId: 'rtn_pending',
    state: 'pending',
    convertedAt: expect.any(String)
  })
  await convertRoutineToTeam({ ...args, link })
  expect(create).toHaveBeenCalledTimes(1)
  expect(enable.mock.calls).toEqual([['rtn_pending'], ['rtn_pending']])
  expect(disable).toHaveBeenCalledTimes(1)
  expect(link?.state).toBe('linked')
})
it.each(['disabled', null, undefined])(
  'does not turn off the local copy without active confirmation (%s)',
  async (status) => {
    const disable = vi.fn(),
      save = vi.fn()
    await expect(
      convertRoutineToTeam({
        id: 'unconfirmed',
        create: async () => ({ id: 'rtn_unconfirmed' }),
        enable: async () => ({ status }),
        disable,
        save
      })
    ).rejects.toThrow('did not confirm')
    expect(disable).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending' }))
  }
)

it.each(['pending', 'enabled'] as const)(
  'guards double submission during the %s step',
  async (state) => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const enable = vi.fn(async () => {
      await waiting
      return { status: 'active' }
    })
    const disable = vi.fn(async () => {
      await waiting
    })
    const create = vi.fn()
    const args = {
      id: `busy-${state}`,
      link: { teamRoutineId: 'rtn_existing', convertedAt: '2026-09-18', state },
      create,
      enable,
      disable,
      save: vi.fn()
    }
    const first = convertRoutineToTeam(args)
    await convertRoutineToTeam(args)
    expect(routineConversionBusy(args.id)).toBe(true)
    expect(create).not.toHaveBeenCalled()
    expect(state === 'pending' ? enable : disable).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(disable).toHaveBeenCalledTimes(1)
    expect(enable).toHaveBeenCalledTimes(state === 'pending' ? 1 : 0)
    expect(routineConversionBusy(args.id)).toBe(false)
  }
)
