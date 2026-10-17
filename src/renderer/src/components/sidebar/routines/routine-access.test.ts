import { expect, it } from 'vitest'
import { resolveRoutineAccess, resolveRoutinePerson, routineInitials } from './routine-access'
import type { TeamRoutine } from '../../../../../shared/console-team-routines-contract'

const roster = [{ id: 'emp_owner', name: 'Owner Person' }]

it('labels the signed-in person You regardless of the roster entry', () => {
  expect(resolveRoutinePerson('emp_owner', roster, 'emp_owner')).toEqual({
    id: 'emp_owner',
    name: 'You'
  })
})
it('falls back to a neutral Teammate label for an id outside the roster', () => {
  expect(resolveRoutinePerson('emp_stranger', roster, 'emp_owner')).toEqual({
    id: 'emp_stranger',
    name: 'Teammate'
  })
})
it('derives collaborators as members minus the owner, resolved by name', () => {
  const routine: TeamRoutine = {
    owner_employee_id: 'emp_owner',
    members: ['emp_owner', 'emp_stranger'],
    viewer_role: 'collaborator',
    access_canonical: true
  }
  const access = resolveRoutineAccess(routine, roster, 'emp_someone_else')
  expect(access.owner).toEqual({ id: 'emp_owner', name: 'Owner Person' })
  expect(access.collaborators).toEqual([{ id: 'emp_stranger', name: 'Teammate' }])
  expect(access.canManage).toBe(false)
})
it('leaves membership undefined for a legacy routine with no access rows yet', () => {
  const routine: TeamRoutine = { members: [], viewer_role: null, access_canonical: false }
  expect(resolveRoutineAccess(routine, roster, 'emp_owner')).toEqual({})
})
it('caps initials at two characters from the first and last name', () => {
  expect(routineInitials('Ada Lovelace')).toBe('AL')
  expect(routineInitials('Cher')).toBe('C')
  expect(routineInitials('')).toBe('')
})
