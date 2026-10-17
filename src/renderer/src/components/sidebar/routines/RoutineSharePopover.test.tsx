// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { RoutineSharePopover } from './RoutineSharePopover'

const mocks = vi.hoisted(() => ({
  share: vi.fn(),
  add: undefined as undefined | ((id: string) => Promise<void>),
  people: {
    people: {
      phase: 'ready',
      value: [
        { id: 'emp_owner', name: 'Owner Person' },
        { id: 'emp_collab', name: 'Collab Person' }
      ]
    },
    employeeId: 'emp_owner'
  },
  sharePopoverProps: undefined as undefined | Record<string, unknown>
}))
vi.mock('./team-routines-client', () => ({ teamRoutinesApi: () => ({ share: mocks.share }) }))
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => mocks.people
}))
vi.mock('@/components/share/SharePeoplePopover', () => ({
  SharePeoplePopover: (
    props: Record<string, unknown> & {
      onAdd: (id: string) => Promise<void>
      children: React.ReactNode
    }
  ) => {
    mocks.add = props.onAdd
    mocks.sharePopoverProps = props
    return props.children
  }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.sharePopoverProps = undefined
})

it('explains host-local sharing without contacting the hub', async () => {
  const user = userEvent.setup()
  render(<RoutineSharePopover name="Local daily" />)
  await user.click(screen.getByRole('button', { name: 'People on Local daily' }))
  expect(
    screen.getByText(
      "This routine runs on its workspace host and can't be shared yet. Team routines can be shared."
    )
  ).toBeTruthy()
  expect(mocks.share).not.toHaveBeenCalled()
})
it('resolves the owner as You and collaborators by name from the roster', () => {
  render(
    <RoutineSharePopover
      name="Team daily"
      routine={{
        id: 'rtn_daily',
        owner_employee_id: 'emp_owner',
        members: ['emp_owner', 'emp_collab'],
        viewer_role: 'owner',
        access_canonical: true
      }}
    />
  )
  expect(mocks.sharePopoverProps?.owner).toEqual({ id: 'emp_owner', name: 'You' })
  expect(mocks.sharePopoverProps?.collaborators).toEqual([
    { id: 'emp_collab', name: 'Collab Person' }
  ])
  expect(mocks.sharePopoverProps?.canManage).toBe(true)
})
it('shows a teammate placeholder for a member id outside the roster, never the raw id', () => {
  render(
    <RoutineSharePopover
      name="Team daily"
      routine={{
        id: 'rtn_daily',
        owner_employee_id: 'emp_stranger',
        members: ['emp_stranger'],
        viewer_role: null,
        access_canonical: true
      }}
    />
  )
  expect(mocks.sharePopoverProps?.owner).toEqual({ id: 'emp_stranger', name: 'Teammate' })
})
it('leaves membership undefined for a legacy routine with no access rows yet', () => {
  render(
    <RoutineSharePopover
      name="Team daily"
      routine={{ id: 'rtn_daily', members: [], viewer_role: null, access_canonical: false }}
    />
  )
  expect(mocks.sharePopoverProps?.owner).toBeUndefined()
  expect(mocks.sharePopoverProps?.collaborators).toBeUndefined()
  expect(mocks.sharePopoverProps?.canManage).toBeUndefined()
})
it('shows a pending ownership transfer notice', () => {
  render(
    <RoutineSharePopover
      name="Team daily"
      routine={{
        id: 'rtn_daily',
        access_canonical: true,
        members: [],
        viewer_role: null,
        pending_handoff: { thread_id: 'hth_1' }
      }}
    />
  )
  expect(mocks.sharePopoverProps?.notice).toBe('Ownership transfer pending')
})
it('adds the employee then replaces the routine with the share response', async () => {
  mocks.share.mockResolvedValue({ ok: true, data: { id: 'rtn_daily', members: ['emp_new'] } })
  const onShared = vi.fn()
  render(
    <RoutineSharePopover
      name="Team daily"
      routine={{ id: 'rtn_daily', members: [], viewer_role: null }}
      onShared={onShared}
    />
  )
  await mocks.add!('emp_person')
  expect(mocks.share).toHaveBeenCalledWith({ id: 'rtn_daily', employeeId: 'emp_person' })
  expect(onShared).toHaveBeenCalledWith({ id: 'rtn_daily', members: ['emp_new'] })
})
it('leaves hub refusals to the sharing UI and does not call onShared', async () => {
  mocks.share.mockResolvedValue({
    ok: false,
    error: { code: 'routine_owner_required', message: 'Only owner' }
  })
  const onShared = vi.fn()
  render(
    <RoutineSharePopover
      name="Team daily"
      routine={{ id: 'rtn_daily', members: [], viewer_role: null }}
      onShared={onShared}
    />
  )
  await expect(mocks.add!('emp_person')).rejects.toThrow('Only owner')
  expect(onShared).not.toHaveBeenCalled()
})
