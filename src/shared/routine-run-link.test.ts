import { expect, it } from 'vitest'
import { buildRoutineRunLink, parseRoutineRunLink } from './routine-run-link'
it('round-trips a navigation-only link with its host', () => {
  const target = { automationId: 'routine-1', runId: 'run_2', hostId: 'runtime:host-1' }
  expect(parseRoutineRunLink(buildRoutineRunLink(target))).toEqual(target)
})
it.each([
  'https://example.com',
  'omni://automation/a/run/b/execute',
  'omni://automation/%2F/run/b',
  'omni://automation/a/run/b?hostId=bad'
])('rejects malformed routine links: %s', (link) => {
  expect(parseRoutineRunLink(link)).toBeNull()
})
