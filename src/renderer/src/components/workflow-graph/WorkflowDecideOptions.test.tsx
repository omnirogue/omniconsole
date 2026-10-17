// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowDecideOptions } from './WorkflowDecideOptions'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, options?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name]))
}))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const

describe('WorkflowDecideOptions', () => {
  it('leaves one-answer routing off, says how far JEV is checked, and turns it on when asked', () => {
    const spec = workflowTemplate('decide', ROUTES)
    const onChange = vi.fn<(next: WorkflowSpec) => void>()
    render(<WorkflowDecideOptions spec={spec} available={ROUTES} onChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: 'Answer one-answer questions with one model' })
    expect(box).not.toBeChecked()
    expect(screen.queryByText(/has not yet been measured/)).toBeNull()
    expect(screen.getByTestId('workflow-judge-check')).toHaveTextContent(
      "Not yet checked against known answers. Treat JEV's judgement here as a first opinion; when it is unsure, the full Decide runs."
    )
    fireEvent.click(box)
    expect(onChange.mock.calls[0]![0].oneAnswer).toEqual({ step: 'direct' })
  })
})
