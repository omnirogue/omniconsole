// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowGraphSetup } from './WorkflowGraphSetup'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('./WorkflowModelPresets', () => ({ WorkflowModelPresets: () => null }))
vi.mock('./WorkflowGraphCanvas', () => ({
  WorkflowGraphCanvas: () => <div data-testid="canvas" />
}))
vi.mock('./WorkflowDescribePanel', () => ({ WorkflowDescribePanel: () => null }))
vi.mock('./WorkflowStepEditor', () => ({ WorkflowStepEditor: () => null }))
vi.mock('./use-workflow-compile', () => ({
  useWorkflowCompile: () => ({ compile: vi.fn() })
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
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const

function draftFor(spec: ReturnType<typeof workflowTemplate>): LocalWorkflowDraft & {
  graph: NonNullable<LocalWorkflowDraft['graph']>
} {
  // Only prompt and graph matter to this component's Find-vs-generic branch; the rest of a real
  // draft (seats, concurrency, limits…) is irrelevant here.
  return { prompt: '', graph: { spec, team: [] } } as unknown as LocalWorkflowDraft & {
    graph: NonNullable<LocalWorkflowDraft['graph']>
  }
}

describe('WorkflowGraphSetup: choosing the Find UI', () => {
  it("shows Find's own controls for a Best of N spec, not the generic step editor", () => {
    const spec = workflowTemplate('best-of-n', ROUTES)
    expect(spec.template).toBe('best-of-n')
    expect(spec.find).toBeTruthy()
    render(
      <WorkflowGraphSetup
        worktreeId="wt-1"
        draft={draftFor(spec)}
        available={ROUTES}
        onChange={vi.fn()}
        onStart={vi.fn()}
      />
    )
    // Find's own "Options" toggle (from WorkflowFindOptions) is present…
    expect(screen.getByRole('button', { name: /Options/ })).toBeInTheDocument()
    // …and the generic graph canvas/step editor for a plain workflow is not.
    expect(screen.queryByTestId('canvas')).toBeNull()
  })

  it('still shows the generic step editor for a template with no find field', () => {
    const spec = workflowTemplate('council', ROUTES)
    expect(spec.find).toBeUndefined()
    render(
      <WorkflowGraphSetup
        worktreeId="wt-1"
        draft={draftFor(spec)}
        available={ROUTES}
        onChange={vi.fn()}
        onStart={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /Options/ })).toBeNull()
    expect(screen.getByTestId('canvas')).toBeInTheDocument()
  })
})
