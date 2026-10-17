// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowJudgeFields } from './WorkflowJudgeFields'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, options?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name]))
}))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const

describe('WorkflowJudgeFields', () => {
  it('says under the judges hint how far this step’s JEV judgement has been checked', () => {
    const spec = workflowTemplate('council', ROUTES)
    const rank = spec.steps.find((step) => step.kind === 'rank' && step.jev)!
    render(<WorkflowJudgeFields spec={spec} step={rank} onInstruction={vi.fn()} onJev={vi.fn()} />)
    expect(screen.getByText(/JEV judges in seconds/)).toBeInTheDocument()
    expect(screen.getByTestId('workflow-judge-check')).toHaveTextContent(
      "Not yet checked against known answers. Treat JEV's judgement here as a first opinion; when it is unsure, the model judges decide."
    )
  })

  it('shows no check line when only the model judges vote', () => {
    const spec = workflowTemplate('council', ROUTES)
    const rank = spec.steps.find((step) => step.kind === 'rank')!
    const models = {
      ...spec,
      steps: spec.steps.map((s) => (s === rank ? { ...s, jev: undefined } : s))
    }
    render(
      <WorkflowJudgeFields
        spec={models}
        step={{ ...rank, jev: undefined }}
        onInstruction={vi.fn()}
        onJev={vi.fn()}
      />
    )
    expect(screen.queryByTestId('workflow-judge-check')).toBeNull()
  })
})
