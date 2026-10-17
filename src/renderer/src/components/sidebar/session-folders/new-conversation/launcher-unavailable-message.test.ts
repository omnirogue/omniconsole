import { expect, it } from 'vitest'
import { launcherUnavailableMessage } from './launcher-unavailable-message'
it('explains task-linked work locations even during loading', () => {
  expect(
    launcherUnavailableMessage(
      [{ id: 'claude', label: 'Claude', status: 'work-plan-required', models: [] }],
      true
    )
  ).toContain('linked to a task')
})
it('distinguishes initial detection from no usable providers', () => {
  expect(launcherUnavailableMessage([], true)).toBe('Checking available agents…')
  expect(launcherUnavailableMessage([])).toContain('No agents are ready')
})
