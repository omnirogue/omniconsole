import { describe, expect, it, vi } from 'vitest'
import { pipelineFixture } from '@/components/build-review/build-review-test-fixture'
import { buildReviewGraphView } from './local-graph-build-review'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))

describe('Build + Review on the Local Runs graph', () => {
  it('says what went wrong in words, keeping the raw line in the timeline', () => {
    const raw =
      'Build + Review pipeline brp_0123456789ab still owns this workspace (Run run_0123456789ab); inspect unresolved Dispatch ctx_0123456789ab.'
    const pipeline = pipelineFixture({
      stage: 'failed',
      pendingQuestion: null,
      error: raw,
      events: [{ at: '2026-09-21T12:00:00Z', kind: 'error', role: 'pipeline', text: raw }],
      builder: {
        ...pipelineFixture().builder,
        status: 'failed',
        report: null,
        error: 'builder: agent_prompt_stalled',
        startupBlocker: 'claude-folder-trust'
      }
    })
    const view = buildReviewGraphView(pipeline)
    expect(view.error).toBe(`The builder could not start. ${claudeTrust}`)
    expect(view.error).not.toMatch(/brp_|run_|ctx_|agent_prompt_stalled/)
    expect(view.nodes[0]?.error).toBe(claudeTrust)
    expect(view.events[0]?.text).toBe(raw)
  })

  it('shows no problem for a run that has none', () => {
    const view = buildReviewGraphView(pipelineFixture())
    expect(view.error).toBeNull()
    expect(view.nodes.every((node) => node.error === null)).toBe(true)
  })
})

const claudeTrust = 'Claude is asking whether to trust this folder — open the terminal to answer.'
