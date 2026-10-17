// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowJudgeCheckLine } from './WorkflowJudgeCheckLine'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, options?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name]))
}))
afterEach(cleanup)

describe('WorkflowJudgeCheckLine', () => {
  it('renders the note as muted text, never as a warning', () => {
    render(
      <WorkflowJudgeCheckLine
        check={{
          point: 'final-check',
          ref: 'council-final-check@1',
          state: 'not-yet',
          fallback: 'keep-chair'
        }}
      />
    )
    const line = screen.getByText(
      "Not yet checked against known answers. Treat JEV's judgement here as a first opinion; when it is unsure, the chairman's answer is kept."
    )
    expect(line).toHaveClass('text-muted-foreground')
    expect(line.className).not.toMatch(/warning|destructive|error/)
    expect(line).not.toHaveAttribute('role')
  })

  it('renders a checked rule with its numbers', () => {
    render(
      <WorkflowJudgeCheckLine
        check={{
          point: 'r/ballot',
          ref: 'generic-rank-ballot@1',
          state: 'checked',
          count: 80,
          agree: 96,
          unsure: 5,
          fallback: 'models-decide'
        }}
      />
    )
    expect(screen.getByTestId('workflow-judge-check')).toHaveTextContent(
      'Checked against 80 questions with known answers. When JEV was sure, it agreed 96% of the time. It was unsure 5% of the time; then the model judges decide.'
    )
  })

  it('renders nothing without a check', () => {
    render(<WorkflowJudgeCheckLine check={undefined} />)
    expect(screen.queryByTestId('workflow-judge-check')).toBeNull()
  })
})
