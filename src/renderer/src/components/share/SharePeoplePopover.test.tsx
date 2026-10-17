// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SharePeoplePopover } from './SharePeoplePopover'
import { CompaniesRequestError } from '@/components/companies/companies-client'

const roster = vi.hoisted(() => ({
  people: {
    phase: 'ready',
    value: [
      { id: 'emp_owner', name: 'Owner Person' },
      { id: 'emp_member', name: 'Existing Person' },
      { id: 'emp_new', name: 'New Person' }
    ]
  },
  peopleIncomplete: false,
  reload: vi.fn()
}))
vi.mock('@/components/next-step/use-handoff-people', () => ({ useHandoffPeople: () => roster }))
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
async function open(canManage = true, onAdd = vi.fn().mockResolvedValue(undefined)) {
  const user = userEvent.setup()
  render(
    <SharePeoplePopover
      subjectKind="routine"
      subjectLabel="Daily"
      owner={{ id: 'emp_owner', name: 'Owner Person' }}
      collaborators={[{ id: 'emp_member', name: 'Existing Person' }]}
      canManage={canManage}
      onAdd={onAdd}
    >
      <button>People</button>
    </SharePeoplePopover>
  )
  await user.click(screen.getByRole('button', { name: 'People' }))
  return { user, onAdd }
}
it('shows the owner and collaborators, excludes existing people from search', async () => {
  await open()
  expect(screen.getByText('Owner')).toBeTruthy()
  expect(screen.getByText('Can talk to the AI')).toBeTruthy()
  expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual(['New Person'])
})
it('makes non-owners read only', async () => {
  await open(false)
  expect(screen.getByText('Only the owner can share this routine.')).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
})
it('optimistically shows pending then confirms an add', async () => {
  let finish!: () => void
  const onAdd = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { user } = await open(true, onAdd)
  await user.click(screen.getByRole('option', { name: 'New Person' }))
  expect(screen.getByText('Adding…')).toBeTruthy()
  expect(onAdd).toHaveBeenCalledWith('emp_new')
  finish()
  await waitFor(() => expect(screen.queryByText('Adding…')).toBeNull())
  expect(screen.getByText('New Person')).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'New Person' })).toBeNull()
})
it.each([
  ['routine_owner_required', 'Only the owner can share this routine.'],
  ['company_access_required', "This person doesn't have access to this company or department."],
  ['department_access_required', "This person doesn't have access to this company or department."],
  ['task_permission_denied', "This person doesn't have access to this company or department."],
  ['unknown_refusal', 'Unable to add this person: Hub explanation']
])('shows %s and rolls back the optimistic person', async (code, message) => {
  const { user } = await open(
    true,
    vi.fn().mockRejectedValue(new CompaniesRequestError({ code, message: 'Hub explanation' }))
  )
  await user.click(screen.getByRole('option', { name: 'New Person' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', message)
  expect(screen.getByRole('option', { name: 'New Person' })).toBeTruthy()
})
it('supports keyboard search, selection and return focus', async () => {
  const { user, onAdd } = await open()
  await user.click(screen.getByRole('combobox'))
  await user.keyboard('New{ArrowDown}{Enter}')
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith('emp_new'))
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'People' }))
  )
})
it('renders a subject-specific notice line when supplied', async () => {
  const user = userEvent.setup()
  render(
    <SharePeoplePopover
      subjectKind="routine"
      subjectLabel="Daily"
      owner={{ id: 'emp_owner', name: 'Owner Person' }}
      collaborators={[]}
      canManage
      notice="Ownership transfer pending"
      onAdd={vi.fn()}
    >
      <button>People</button>
    </SharePeoplePopover>
  )
  await user.click(screen.getByRole('button', { name: 'People' }))
  expect(screen.getByText('Ownership transfer pending')).toBeTruthy()
})
it('does not invent an owner or empty membership for undocumented responses', async () => {
  const user = userEvent.setup()
  render(
    <SharePeoplePopover subjectKind="routine" subjectLabel="Daily" onAdd={vi.fn()}>
      <button>People</button>
    </SharePeoplePopover>
  )
  await user.click(screen.getByRole('button', { name: 'People' }))
  expect(
    screen.getByText(
      'The hub has not provided owner or collaborator details. Only the owner can share; the hub checks each request.'
    )
  ).toBeTruthy()
  expect(screen.queryByText('Owner')).toBeNull()
  expect(screen.getByRole('combobox', { name: 'Add a person…' })).toBeTruthy()
})
