// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowGraphDraft } from '../../../../shared/local-workflow-draft'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { WorkflowGraphSetup } from './WorkflowGraphSetup'

const { compile } = vi.hoisted(() => ({ compile: vi.fn() }))
vi.mock('./use-workflow-compile', () => ({
  useWorkflowCompile: () => ({ compile, compiling: false, cancel: vi.fn() })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ROUTES = ['claude', 'codex', 'grok'] as const
describe('workflow graph setup', () => {
  const custom = createLocalWorkflowGraphDraft({
    prompt: '',
    graph: { spec: normalizeWorkflowSpec({ template: 'custom', steps: [] }), team: [] }
  }) as Parameters<typeof WorkflowGraphSetup>[0]['draft']

  it('builds a custom workflow from a description and runs it once it is valid and has a task', async () => {
    const onChange = vi.fn()
    const onStart = vi.fn().mockResolvedValue(undefined)
    const compiled = normalizeWorkflowSpec(
      {
        title: 'Research panel',
        template: 'custom',
        steps: [
          { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}, {}, {}] },
          {
            id: 'critics',
            kind: 'review',
            title: 'Critics',
            agents: [{}, {}],
            inputs: ['research']
          },
          { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'critics'] }
        ]
      },
      ROUTES
    )
    compile.mockResolvedValue({
      spec: compiled,
      task: 'How should we cache the build?',
      assumptions: [],
      validation: { problems: [], warnings: [] }
    })
    const { rerender } = render(
      <WorkflowGraphSetup
        worktreeId="w"
        draft={custom}
        available={ROUTES}
        onChange={onChange}
        onStart={onStart}
      />
    )
    expect(screen.queryByRole('group', { name: 'Workflow steps' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Workflow description'), {
      target: { value: 'Have 4 agents research, 2 critics, one synthesizer.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Build' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const next = onChange.mock.calls.at(-1)![0]
    expect(next.prompt).toBe('How should we cache the build?')
    expect(screen.getByText('Research: 4 agents work in parallel.')).toBeVisible()
    rerender(
      <WorkflowGraphSetup
        worktreeId="w"
        draft={next}
        available={ROUTES}
        onChange={onChange}
        onStart={onStart}
      />
    )
    expect(screen.getByText('Ready · up to 7 agent calls')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
    expect(onStart.mock.calls[0][0].graph.spec.steps).toHaveLength(3)
  })

  it('keeps Run disabled and pins the problem to its step when the graph is invalid', () => {
    const draft = {
      ...custom,
      prompt: 'Task',
      graph: {
        ...custom.graph,
        spec: normalizeWorkflowSpec(
          {
            template: 'custom',
            steps: [
              { id: 'a', kind: 'do', title: 'Answer', agents: [{}] },
              { id: 's', kind: 'synthesize', title: 'Combine', inputs: ['a'] }
            ]
          },
          ROUTES
        )
      }
    }
    render(
      <WorkflowGraphSetup
        worktreeId="w"
        draft={draft}
        available={ROUTES}
        onChange={vi.fn()}
        onStart={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Combine/ })).toHaveTextContent('1 to fix')
    expect(screen.getByRole('alert')).toHaveTextContent('nothing to combine')
  })
})
