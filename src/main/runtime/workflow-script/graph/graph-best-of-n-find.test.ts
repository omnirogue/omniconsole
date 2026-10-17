import { describe, expect, it } from 'vitest'
import { workflowSetFind } from '../../../../shared/workflow-graph-find'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

const ROUTES = ['claude', 'codex', 'grok'] as const

function answer(call: GraphCall) {
  if (call.check) {
    return { passed: true, detail: 'ok' }
  }
  if (call.screen) {
    return {
      markdown: 'screen',
      scores: Object.fromEntries(call.screen.candidates.map((entry, i) => [entry.id, 4 - i / 10])),
      criteria: [],
      unscored: []
    }
  }
  if (call.jev) {
    return text(
      `FINAL RANKING:\n${call.jev.candidates.map((entry, i) => `${i + 1}. ${entry.label}`).join('\n')}`
    )
  }
  return text(`Complete version ${call.agentIndex + 1}, written in full.`)
}

describe('new Best of N runs through Find', () => {
  it.each([false, true])('replays the same pipeline and results (check: %s)', (check) => {
    const settings = {
      top: 2,
      ...(check ? { check: { command: 'node check.mjs {candidate}' } } : {})
    }
    const spec = workflowSetFind(workflowTemplate('best-of-n', ROUTES), settings, ROUTES)
    const existing = workflowSetFind(
      workflowTemplate('find', ROUTES),
      { ...settings, versions: true, count: 4 },
      ROUTES
    )
    const plan = drive(spec, answer)
    expect(JSON.stringify(plan)).toBe(JSON.stringify(drive(existing, answer)))
    expect(plan.calls.filter((call) => call.check)).toHaveLength(check ? 4 : 0)
    expect(plan.calls.find((call) => call.screen)?.screen?.candidates).toHaveLength(4)
    expect(plan.calls.find((call) => call.jev)?.jev?.candidates).toHaveLength(2)
    expect(plan.find).toMatchObject({ stage: 'done', source: 'versions', pool: 4 })
    expect(plan.find?.rows).toHaveLength(4)
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toContain('## Best version:')
    expect(plan.outcome?.final?.markdown).toContain('Complete version 1, written in full.')
  })
})
