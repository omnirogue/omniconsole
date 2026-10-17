// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { WorkflowImproveOptions } from './WorkflowImproveOptions'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
vi.mock('./workflow-graph-controls', () => ({
  WorkflowSelect: ({
    value,
    options,
    onChange
  }: {
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const

describe('WorkflowImproveOptions', () => {
  it('offers who judges in plain words and leaves rubric presets and JEV methods to Customize', () => {
    const spec = workflowTemplate('improve', ROUTES)
    const onChange = vi.fn<(next: WorkflowSpec) => void>()
    render(
      <WorkflowImproveOptions
        spec={spec}
        available={ROUTES}
        onChange={onChange}
        onCustomize={vi.fn()}
        onDescribe={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Options/ }))
    expect(screen.getByText('Judges')).toBeInTheDocument()
    expect(screen.getByText('What good means (optional)')).toBeInTheDocument()
    expect(screen.queryByText('How JEV compares')).toBeNull()
    expect(screen.queryByText('Rubric (optional)')).toBeNull()
    const judges = screen.getByDisplayValue('JEV · models if needed')
    fireEvent.change(judges, { target: { value: 'models' } })
    const judge = onChange.mock.calls[0]![0].steps.find((step) => step.id === 'judge')!
    expect('jev' in judge).toBe(false)
  })

  it("shows each prompt's built-in wording, keeps the person's own, and goes back on request", () => {
    const spec = workflowTemplate('improve', ROUTES)
    const onChange = vi.fn<(next: WorkflowSpec) => void>()
    const props = { available: ROUTES, onChange, onCustomize: vi.fn(), onDescribe: vi.fn() }
    const { rerender } = render(<WorkflowImproveOptions spec={spec} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Options/ }))
    const wording = () => screen.getByLabelText('Prompt wording') as HTMLTextAreaElement
    expect(wording().value).toContain('State only facts the task and the material above give')
    fireEvent.change(wording(), { target: { value: '- Keep it short.' } })
    const edited = onChange.mock.calls.at(-1)![0]
    expect(edited.repeat?.prompts).toEqual({ rules: '- Keep it short.' })
    rerender(<WorkflowImproveOptions spec={edited} {...props} />)
    expect(screen.getByRole('button', { name: /own prompts/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use the built-in wording' }))
    expect(onChange.mock.calls.at(-1)![0].repeat?.prompts).toBeUndefined()
    fireEvent.change(screen.getByDisplayValue('Rules for every version'), {
      target: { value: 'improve' }
    })
    expect(wording().value).toContain('Below is the best version so far')
  })
})
