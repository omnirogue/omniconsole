// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'
import { createRoutineCommands } from './routine-row-commands'
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  disable: vi.fn(),
  update: vi.fn(),
  link: { teamRoutineId: 'rtn_team' }
}))
vi.mock('./team-routines-client', () => ({
  teamRoutinesApi: () => ({ get: mocks.get, disable: mocks.disable })
}))
vi.mock('./routine-team-links', () => ({
  TEAM_ROUTINES_CHANGED: 'omni:team-routines-changed',
  readRoutineTeamLink: () => mocks.link
}))
vi.mock('@/components/automations/automation-host-client', () => ({
  updateAutomationForTarget: mocks.update,
  deleteAutomationForTarget: vi.fn(),
  runAutomationNowForTarget: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const automation = { id: 'a', enabled: false } as Automation
beforeEach(() => {
  vi.resetAllMocks()
  // happy-dom ships no window.confirm; give the spies below a real function to wrap.
  window.confirm = () => false
  mocks.update.mockResolvedValue({ ...automation, enabled: true })
})
it('reads status before enabling a linked local copy', async () => {
  let resolve!: (value: unknown) => void
  mocks.get.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const patch = vi.fn()
  const commands = createRoutineCommands({
    target: { kind: 'local' },
    patch,
    remove: vi.fn()
  })
  const result = commands.setEnabled(automation, true)
  expect(mocks.update).not.toHaveBeenCalled()
  resolve({ ok: true, data: { status: 'disabled' } })
  expect(await result).toBe(true)
  expect(mocks.get).toHaveBeenCalledWith({ id: 'rtn_team' })
})
it.each([
  ['active', false, false],
  ['active', true, true],
  [null, false, false]
])('requires double-run confirmation for status %s', async (status, approval, enabled) => {
  mocks.get.mockResolvedValue({ ok: true, data: { status } })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(approval as boolean)
  const commands = createRoutineCommands({
    target: { kind: 'local' },
    patch: vi.fn(),
    remove: vi.fn()
  })
  expect(await commands.setEnabled(automation, true)).toBe(enabled)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(mocks.update).toHaveBeenCalledTimes(enabled ? 1 : 0)
  confirm.mockRestore()
})
it('does not enable or optimistically patch if status cannot be read', async () => {
  mocks.get.mockResolvedValue({
    ok: false,
    error: { code: 'unavailable', message: 'Hub unavailable' }
  })
  const patch = vi.fn()
  const commands = createRoutineCommands({
    target: { kind: 'local' },
    patch,
    remove: vi.fn()
  })
  expect(await commands.setEnabled(automation, true)).toBe(false)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(patch).not.toHaveBeenCalled()
})

it('lets the owner turn off the team routine before restoring locally', async () => {
  mocks.get.mockResolvedValue({
    ok: true,
    data: { status: 'active', viewer_role: 'owner' }
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  let finish!: (value: unknown) => void
  mocks.disable.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const commands = createRoutineCommands({
    target: { kind: 'local' },
    patch: vi.fn(),
    remove: vi.fn()
  })
  const result = commands.setEnabled(automation, true)
  await vi.waitFor(() => expect(mocks.disable).toHaveBeenCalledWith({ id: 'rtn_team' }))
  expect(mocks.update).not.toHaveBeenCalled()
  expect(await commands.setEnabled(automation, true)).toBe(false)
  finish({ ok: true, data: { status: 'disabled' } })
  expect(await result).toBe(true)
  expect(confirm).toHaveBeenCalledTimes(1)
  confirm.mockRestore()
})
it.each(['collaborator', null, 'owner'])(
  'keeps warn-then-proceed for %s leaving team on',
  async (viewer_role) => {
    mocks.get.mockResolvedValue({
      ok: true,
      data: { status: 'active', viewer_role }
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    if (viewer_role === 'owner') {
      confirm.mockReturnValueOnce(false)
    }
    const commands = createRoutineCommands({
      target: { kind: 'local' },
      patch: vi.fn(),
      remove: vi.fn()
    })
    expect(await commands.setEnabled(automation, true)).toBe(true)
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('may run both copies'))
    expect(mocks.disable).not.toHaveBeenCalled()
    confirm.mockRestore()
  }
)
it('keeps the local copy off when team disable fails and allows another choice', async () => {
  mocks.get.mockResolvedValue({
    ok: true,
    data: { status: 'active', viewer_role: 'owner' }
  })
  mocks.disable.mockResolvedValue({
    ok: false,
    error: { code: 'forbidden', message: 'Owner changed' }
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const patch = vi.fn()
  const commands = createRoutineCommands({
    target: { kind: 'local' },
    patch,
    remove: vi.fn()
  })
  expect(await commands.setEnabled(automation, true)).toBe(false)
  expect(patch).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
  confirm.mockReturnValueOnce(false).mockReturnValueOnce(true)
  expect(await commands.setEnabled(automation, true)).toBe(true)
  expect(mocks.disable).toHaveBeenCalledTimes(1)
  confirm.mockRestore()
})
