import { expect, it } from 'vitest'
import { teamRoutine, teamRoutines, teamRoutineRuns } from './console-team-routines-contract'

it('decodes the full access shape', () => {
  const payload = {
    id: 'rtn_demo_123',
    title: 'Daily check',
    owner_employee_id: 'emp_owner',
    members: ['emp_owner', 'emp_collab'],
    viewer_role: 'owner',
    access_canonical: true,
    pending_handoff: { thread_id: 'hth_1', to_employee_id: 'emp_collab' }
  }
  expect(teamRoutine.parse(payload)).toEqual(payload)
})
it('decodes a legacy routine with none of the access keys, defaulting membership', () => {
  const payload = { id: 'rtn_demo_123', name: 'Daily check' }
  expect(teamRoutine.parse(payload)).toEqual({ ...payload, members: [], viewer_role: null })
})
it('includes the owner in members, leaving collaborator derivation to the caller', () => {
  const payload = { owner_employee_id: 'emp_owner', members: ['emp_owner', 'emp_collab'] }
  expect(teamRoutine.parse(payload).members).toEqual(['emp_owner', 'emp_collab'])
})
it('falls back an unknown viewer_role to null rather than inventing a role', () => {
  expect(teamRoutine.parse({ viewer_role: 'editor' }).viewer_role).toBeNull()
  expect(teamRoutine.parse({ viewer_role: null }).viewer_role).toBeNull()
})
it('falls back a malformed members list to empty rather than failing the whole routine', () => {
  expect(teamRoutine.parse({ members: 'emp_owner' }).members).toEqual([])
})
it('preserves unknown fields without inventing membership', () => {
  const payload = { id: 'rtn_demo_123', name: 'Daily check', future: { version: 2 } }
  expect(teamRoutine.parse(payload)).toEqual({ ...payload, members: [], viewer_role: null })
})
it('accepts absent and nullable optional presentation fields', () => {
  expect(teamRoutines.parse([{ name: null, status: null, trigger_config: null }])).toHaveLength(1)
})
it('rejects invalid known fields and non-array list envelopes', () => {
  expect(teamRoutine.safeParse({ name: 42 }).success).toBe(false)
  expect(teamRoutines.safeParse({ routines: [] }).success).toBe(false)
  expect(teamRoutine.safeParse({ id: 'rtn_demo/evil' }).success).toBe(false)
})
it('retains undocumented run fields', () => {
  expect(teamRoutineRuns.parse([{ state: 'finished', future: true }])).toEqual([
    { state: 'finished', future: true }
  ])
})
