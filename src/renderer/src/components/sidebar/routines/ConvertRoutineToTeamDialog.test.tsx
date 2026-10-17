// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'
import type { RoutineCommands } from './routine-row-commands'
import type { RoutineTeamLink } from './routine-team-conversion'
import { ConvertRoutineToTeamDialog } from './ConvertRoutineToTeamDialog'
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  link: undefined as RoutineTeamLink | undefined,
  save: vi.fn()
}))
vi.mock('./team-routines-client', () => ({
  teamRoutinesApi: () => ({ create: mocks.create, enable: mocks.enable })
}))
vi.mock('./routine-team-links', () => ({
  useRoutineTeamLink: () => mocks.link,
  readRoutineTeamLink: () => mocks.link,
  routineTeamLinkStorageKey: () => 'test',
  saveRoutineTeamLink: (id: string, link: RoutineTeamLink) => {
    mocks.link = link
    mocks.save(id, link)
  },
  viewTeamRoutine: vi.fn()
}))
vi.mock('@/components/companies/use-work-folders', () => ({
  useWorkFoldersScope: () => 'test-account'
}))
vi.mock('./RoutineTeamScopePicker', () => ({
  RoutineTeamScopePicker: ({ onChange }: { onChange: (scope: string) => void }) => (
    <button onClick={() => onChange('omnirogue/marketing')}>Select department</button>
  )
}))
const automation = {
  id: 'local',
  name: 'Daily summary',
  prompt: 'Summarize activity',
  projectId: '',
  executionTargetType: 'local',
  executionTargetId: 'local',
  workspaceMode: 'new_per_run',
  timezone: 'UTC',
  dtstart: Date.parse('2026-01-01T09:00:00Z'),
  rrule: 'FREQ=DAILY',
  enabled: true
} as Automation
const commands = { setEnabled: mocks.disable } as unknown as RoutineCommands
function show(patch: Partial<Automation> = {}): void {
  render(
    <ConvertRoutineToTeamDialog
      automation={{ ...automation, ...patch }}
      commands={commands}
      onClose={vi.fn()}
    />
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.link = undefined
  mocks.disable.mockResolvedValue(true)
  mocks.enable.mockResolvedValue({
    ok: true,
    data: { status: 'active', next_due: '2026-09-19T09:00:00Z' }
  })
})
afterEach(cleanup)
it('shows the prompt, both clocks, immediate activation consequences and requires scope', () => {
  show()
  expect(screen.getByDisplayValue('Summarize activity').getAttribute('readonly')).not.toBeNull()
  expect(screen.getByText(/Your time/)).toBeTruthy()
  expect(screen.getByText(/Server time/)).toBeTruthy()
  expect(screen.getByText(/turned on right away/)).toBeTruthy()
  const confirm = screen.getByRole('button', {
    name: 'Make this a team routine'
  }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.click(screen.getByText('Select department'))
  expect(confirm.disabled).toBe(false)
})
it('requires a checkbox and different confirmation for machine dependencies', () => {
  show({ projectId: 'local-project', prompt: 'Read ~/report' })
  fireEvent.click(screen.getByText('Select department'))
  const confirm = screen.getByRole('button', {
    name: 'Create team routine despite dependencies'
  }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  expect(screen.getByText('This routine is bound to a local project.')).toBeTruthy()
  expect(screen.getByText('The instructions refer to a machine-local file path.')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(confirm.disabled).toBe(false)
})
it('shows an already-converted routine instead of the creation form', () => {
  mocks.link = {
    teamRoutineId: 'rtn_existing',
    convertedAt: '2026-01-01',
    state: 'linked'
  }
  show({ enabled: false })
  expect(screen.getByText('Moved to team')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'View team routine' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Turn this Mac copy back on' })).toBeTruthy()
  expect(screen.queryByText('Select department')).toBeNull()
  expect(mocks.create).not.toHaveBeenCalled()
})
it('ignores double clicks while awaiting create and only then disables', async () => {
  let finish!: (value: unknown) => void
  mocks.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  show()
  fireEvent.click(screen.getByText('Select department'))
  const confirm = screen.getByRole('button', {
    name: 'Make this a team routine'
  })
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.disable).not.toHaveBeenCalled()
  finish({ ok: true, data: { id: 'rtn_new' } })
  await waitFor(() => expect(mocks.disable).toHaveBeenCalledWith(automation, false))
})
it('keeps create failures visible and never mutates the local copy', async () => {
  mocks.create.mockResolvedValue({
    ok: false,
    error: {
      code: 'bad_scope',
      message: 'Unknown department from hub',
      status: 400
    }
  })
  show()
  fireEvent.click(screen.getByText('Select department'))
  fireEvent.click(screen.getByRole('button', { name: 'Make this a team routine' }))
  await screen.findByText('Unknown department from hub')
  expect(mocks.disable).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})
it('reopens a partial conversion with a disable-only retry', async () => {
  mocks.link = {
    teamRoutineId: 'rtn_existing',
    convertedAt: '2026-01-01',
    state: 'enabled'
  }
  show()
  expect(screen.getByRole('alert').textContent).toContain('still needs to be turned off')
  fireEvent.click(screen.getByRole('button', { name: 'Retry turning off this Mac copy' }))
  await waitFor(() => expect(mocks.disable).toHaveBeenCalledTimes(1))
  expect(mocks.create).not.toHaveBeenCalled()
})
it('refuses DST-unsafe schedules without showing a server schedule', () => {
  show({ timezone: 'America/New_York' })
  fireEvent.click(screen.getByText('Select department'))
  expect(screen.getByText(/crosses a daylight-saving change/)).toBeTruthy()
  expect(screen.queryByText(/Server time/)).toBeNull()
  expect(
    (
      screen.getByRole('button', {
        name: 'Make this a team routine'
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true)
})

it('reopens pending enable with retry and keep-local choices, preserving the same ID', async () => {
  mocks.link = {
    teamRoutineId: 'rtn_pending',
    convertedAt: '2026-01-01',
    state: 'pending'
  }
  show()
  expect(screen.getByText(/currently OFF/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Keep using this Mac for now' })).toBeTruthy()
  expect(screen.queryByText('Select department')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry enable' }))
  await screen.findByText(/Next run:/)
  expect(mocks.enable).toHaveBeenCalledWith({ id: 'rtn_pending' })
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.disable).toHaveBeenCalledWith(automation, false)
})
it('surfaces activation failure while leaving the local copy enabled', async () => {
  mocks.create.mockResolvedValue({ ok: true, data: { id: 'rtn_pending' } })
  mocks.enable.mockResolvedValue({
    ok: false,
    error: { code: 'not_ready', message: 'Proof of life required' }
  })
  show()
  fireEvent.click(screen.getByText('Select department'))
  fireEvent.click(screen.getByRole('button', { name: 'Make this a team routine' }))
  await screen.findByText('Proof of life required')
  expect(screen.getByRole('button', { name: 'Retry enable' })).toBeTruthy()
  expect(mocks.link).toMatchObject({
    state: 'pending',
    teamRoutineId: 'rtn_pending'
  })
  expect(mocks.disable).not.toHaveBeenCalled()
})
it('keeps a pending receipt and local automation untouched on safe exit', () => {
  mocks.link = {
    teamRoutineId: 'rtn_pending',
    convertedAt: '2026-01-01',
    state: 'pending'
  }
  const onClose = vi.fn()
  render(
    <ConvertRoutineToTeamDialog automation={automation} commands={commands} onClose={onClose} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Keep using this Mac for now' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(mocks.link.state).toBe('pending')
  expect(mocks.enable).not.toHaveBeenCalled()
  expect(mocks.disable).not.toHaveBeenCalled()
})
