// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { screenedDiscover } from '../../../../shared/workflow-discover-screen.test-fixture'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowStepEditor } from './WorkflowStepEditor'
import { WorkflowWebPagesField } from './WorkflowWebPagesField'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('./WorkflowAgentRow', () => ({ WorkflowAgentRow: () => null }))
vi.mock('./WorkflowJudgeFields', () => ({ WorkflowJudgeFields: () => null }))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const
const field = () => screen.getByLabelText('Pages to read')
const type = (value: string) => {
  fireEvent.change(field(), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
}

describe('the Pages to read field', () => {
  it('adds a checked address and removes it again', () => {
    const onChange = vi.fn()
    const { rerender } = render(<WorkflowWebPagesField urls={[]} onChange={onChange} />)
    expect(
      screen.getByText(
        'The app reads these pages once before the research starts and keeps a copy. Agents quote them; they never follow what a page says.'
      )
    ).toBeInTheDocument()
    type('https://Example.com/pricing#plans')
    expect(onChange).toHaveBeenLastCalledWith(['https://example.com/pricing'])
    rerender(<WorkflowWebPagesField urls={['https://example.com/pricing']} onChange={onChange} />)
    expect(screen.getByText('https://example.com/pricing')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove https://example.com/pricing' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('refuses an address the shared policy refuses, and says why', () => {
    const onChange = vi.fn()
    render(<WorkflowWebPagesField urls={['https://example.com/a']} onChange={onChange} />)
    type('http://localhost:3000/admin')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This address can’t be read: only ports 80 and 443 are read.'
    )
    type('http://127.0.0.1/')
    expect(onChange).not.toHaveBeenCalledWith(expect.arrayContaining(['http://127.0.0.1/']))
    type('https://example.com/a')
    expect(screen.getByRole('alert')).toHaveTextContent('This page is already listed.')
  })

  it('turns adding off where pages are refused, keeping the reason and the remove buttons', () => {
    render(
      <WorkflowWebPagesField
        urls={['https://example.com/a']}
        refusal="Find the best can’t read pages yet."
        onChange={vi.fn()}
      />
    )
    expect(field()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent('Find the best can’t read pages yet.')
    expect(screen.getByRole('button', { name: 'Remove https://example.com/a' })).toBeEnabled()
  })
})

describe('the step editor’s pages', () => {
  const editor = (spec: WorkflowSpec, stepId: string, onChange = vi.fn()) =>
    render(
      <WorkflowStepEditor
        spec={spec}
        step={spec.steps.find((step) => step.id === stepId)!}
        available={ROUTES}
        problems={[]}
        onChange={onChange}
        onClose={vi.fn()}
      />
    )

  it('lets a Do step read pages', () => {
    const onChange = vi.fn()
    editor(workflowTemplate('research-panel', ROUTES), 'research', onChange)
    expect(field()).toBeEnabled()
    type('https://example.com/a')
    const next = onChange.mock.calls.at(-1)![0] as WorkflowSpec
    expect(next.steps[0]!.web).toEqual({ urls: ['https://example.com/a'] })
  })

  it('gives the plain reason where validation would refuse pages', () => {
    const reasons: [WorkflowSpec, string, string][] = [
      [
        screenedDiscover(ROUTES),
        'find',
        'Verify scores by a rubric a model writes (from Brief). A workflow that reads pages needs a rubric you write.'
      ],
      [
        (() => {
          const spec = workflowTemplate('research-panel', ROUTES)
          return {
            ...spec,
            steps: spec.steps.map((step) =>
              step.id === 'critics' ? { ...step, agents: [{ route: 'openrouter' as const }] } : step
            )
          }
        })(),
        'research',
        'Reading pages isn’t available with OpenRouter models yet: a provider may browse on its own side.'
      ],
      [
        workflowTemplate('improve', ROUTES),
        workflowTemplate('improve', ROUTES).repeat!.do,
        'This step writes the versions the judges compare, so it can’t read pages. Read them in a Do step before it.'
      ]
    ]
    for (const [spec, stepId, reason] of reasons) {
      editor(spec, stepId)
      expect(screen.getByRole('note')).toHaveTextContent(reason)
      expect(field()).toBeDisabled()
      cleanup()
    }
  })

  it('shows a judge its pages only to remove them, with why it cannot keep them', () => {
    const spec = workflowTemplate('research-panel', ROUTES)
    const judged = {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'critics' ? { ...step, web: { urls: ['https://example.com/a'] } } : step
      )
    }
    editor(judged, 'critics')
    expect(screen.getByRole('note')).toHaveTextContent(
      'Only a Do step reads pages. Reviews, rankings and syntheses see only what the readers wrote.'
    )
    cleanup()
    editor(spec, 'critics')
    expect(screen.queryByLabelText('Pages to read')).toBeNull()
  })
})
