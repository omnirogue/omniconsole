import { describe, expect, it } from 'vitest'
import { prependNextOutcomeDiscovery } from '../../../shared/next-outcome-intent-instructions'
import { buildAgentStartupPlan } from '../../../shared/tui-agent-startup'
import { buildDispatchPreamble } from './preamble'

describe('source launch outcome discovery', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'delivers the source request on %s without outcome instructions',
    (platform) => {
      const source = 'Save the report to /output/result.md'
      const plan = buildAgentStartupPlan({
        agent: 'claude',
        prompt: source,
        cmdOverrides: {},
        platform
      })
      expect(plan).not.toBeNull()
      const delivered = `${plan!.launchCommand}\n${plan!.followupPrompt}`
      expect(delivered).toContain(source)
      expect(delivered).not.toContain('outcome context')
      expect(delivered).not.toContain('omni-outcome-source-v1')
    }
  )
  it('does not duplicate the discovery prefix or start an empty source prompt', () => {
    const once = prependNextOutcomeDiscovery('Write the report', 'omni')
    expect(prependNextOutcomeDiscovery(once, 'omni')).toBe(once)
    expect(prependNextOutcomeDiscovery('', 'omni')).toBe('')
    expect(once).toContain('without creating another outcome set')
  })
  it('uses the dispatch scoped launcher and capability, while preserving the exact task spec', () => {
    const result = buildDispatchPreamble({
      taskId: 'task',
      dispatchId: 'dispatch',
      taskSpec: 'Save /output/result.md',
      coordinatorHandle: 'coordinator',
      workerHandle: 'worker',
      cliCommand: '/app/bin/omni',
      dispatchCapability: 'test-capability'
    })
    expect(result).toContain('outcome context --dispatch-capability test-capability --json')
    expect(result).toContain('=== TASK ===\nSave /output/result.md')
    expect(result).toContain('do not report that refusal as a limitation')
  })
})
