import { expect, it, vi } from 'vitest'
import type { Automation } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { createAutomationRun, type AutomationRunOperations } from './automation-run-operations'

it('persists a per-run prompt and apply title without changing the automation', () => {
  const automation = { id: 'a', name: 'Advertising', prompt: 'Review ads' } as Automation
  const operations: AutomationRunOperations = {
    state: {
      repos: [],
      automations: [automation],
      automationRuns: []
    } as unknown as PersistedState,
    flush: vi.fn(),
    recordManualRun: vi.fn(),
    getWorkspaceDisplayName: () => null
  }
  const run = createAutomationRun(operations, automation, 1, 'manual', {
    promptOverride: 'APPLY: selected',
    titleSuffix: 'apply a1'
  })
  expect(run).toMatchObject({
    title: 'Advertising run 1 · apply a1',
    promptOverride: 'APPLY: selected',
    runNumber: 1
  })
  expect(operations.state.automationRuns[0]).toBe(run)
  expect(automation.prompt).toBe('Review ads')
  expect(createAutomationRun(operations, automation, 1)).toBe(run)
  expect(createAutomationRun(operations, automation, 2)).toMatchObject({
    title: 'Advertising run 2',
    promptOverride: null
  })
})
