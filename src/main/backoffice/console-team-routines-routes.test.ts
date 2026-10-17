import { expect, it } from 'vitest'
import { teamRoutineRoutes } from './console-team-routines-routes'

it.each(['enable', 'disable'])('only accepts bounded routine IDs for POST %s', (verb) => {
  const entry = teamRoutineRoutes.POST.find((route) =>
    route.test.test(`/api/routines/rtn_a/${verb}`)
  )!
  expect(entry).toBeDefined()
  for (const id of ['rtn_a', 'rtn_demo_123', `rtn_${'a'.repeat(128)}`]) {
    expect(entry.test.test(`/api/routines/${id}/${verb}`)).toBe(true)
  }
  for (const id of ['rtn_', 'other_123', 'rtn_a-b', 'rtn_a/evil', `rtn_${'a'.repeat(129)}`]) {
    expect(entry.test.test(`/api/routines/${id}/${verb}`)).toBe(false)
  }
  expect(entry.test.test(`/api/routines/rtn_a/${verb}/extra`)).toBe(false)
  expect(
    teamRoutineRoutes.GET.some((route) => route.test.test(`/api/routines/rtn_a/${verb}`))
  ).toBe(false)
})
