// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { screenedDiscover } from '../../../../shared/workflow-discover-screen.test-fixture'
import {
  workflowTemplate,
  type WorkflowTemplateKey
} from '../../../../shared/workflow-graph-templates'
import { workflowWebScreenRubric } from '../../../../shared/workflow-web-setup'
import { WorkflowGraphSetup } from './WorkflowGraphSetup'

vi.mock('@/i18n/i18n', () => ({
  i18n: {
    language: 'en',
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? ''
  },
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('./WorkflowModelPresets', () => ({ WorkflowModelPresets: () => null }))
vi.mock('./WorkflowGraphCanvas', () => ({ WorkflowGraphCanvas: () => null }))
vi.mock('./WorkflowDescribePanel', () => ({ WorkflowDescribePanel: () => null }))
vi.mock('./WorkflowStepEditor', () => ({ WorkflowStepEditor: () => null }))
vi.mock('./WorkflowDecideOptions', () => ({ WorkflowDecideOptions: () => null }))
vi.mock('./use-workflow-compile', () => ({ useWorkflowCompile: () => ({ compile: vi.fn() }) }))
vi.mock('./workflow-graph-controls', () => ({ WorkflowSelect: () => null }))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const
const PAGE = 'https://example.com/pricing'
type GraphDraft = LocalWorkflowDraft & { graph: NonNullable<LocalWorkflowDraft['graph']> }
let latest: GraphDraft | undefined

function Harness({
  template,
  prompt = '',
  spec
}: {
  template: WorkflowTemplateKey
  prompt?: string
  spec?: WorkflowSpec
}) {
  const [draft, setDraft] = useState(
    () =>
      ({
        prompt,
        graph: { spec: spec ?? workflowTemplate(template, ROUTES), team: [] }
      }) as unknown as GraphDraft
  )
  latest = draft
  return (
    <WorkflowGraphSetup
      worktreeId="wt-1"
      draft={draft}
      available={ROUTES}
      onChange={(next) => setDraft(next as GraphDraft)}
      onStart={vi.fn()}
    />
  )
}

const pages = (id: string) => latest!.graph.spec.steps.find((step) => step.id === id)?.web?.urls
const task = () => screen.getByRole('textbox', { name: 'What should the workflow work on?' })
const rubricOf = (): ReturnType<typeof workflowWebScreenRubric> =>
  workflowWebScreenRubric(latest!.graph.spec as WorkflowSpec)

describe('Pages to read in setup', () => {
  it('Investigate: fills in the request’s addresses once the person leaves the request, each removable', () => {
    render(<Harness template="investigate" />)
    fireEvent.change(task(), { target: { value: `Is ${PAGE} still right? Not http://10.0.0.2/` } })
    expect(pages('investigate')).toBeUndefined()
    fireEvent.blur(task())
    expect(pages('investigate')).toEqual([PAGE])
    expect(screen.getByText(PAGE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `Remove ${PAGE}` }))
    expect(pages('investigate')).toBeUndefined()
    // Removed once, the request never offers it again.
    fireEvent.blur(task())
    expect(pages('investigate')).toBeUndefined()
  })

  it('Research panel: offers the addresses a request already had, and adds them on request', () => {
    render(<Harness template="research-panel" prompt={`Summarise ${PAGE}`} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add the address from your request' }))
    expect(pages('research')).toEqual([PAGE])
  })

  it('Discover: reads on Find with no rubric to write, since it has no screen', () => {
    render(<Harness template="discover" prompt={`Audit ${PAGE}`} />)
    fireEvent.blur(task())
    expect(pages('find')).toEqual([PAGE])
    expect(screen.queryByText('Reading pages needs a written rubric')).toBeNull()
    expect(rubricOf()).toBeUndefined()
  })

  it('Discover with a screen: reads on Find and asks for a written or generic rubric', () => {
    render(<Harness template="discover" spec={screenedDiscover(ROUTES)} prompt={`Audit ${PAGE}`} />)
    fireEvent.blur(task())
    expect(pages('find')).toEqual([PAGE])
    expect(screen.getByText('Reading pages needs a written rubric')).toBeInTheDocument()
    expect(rubricOf()).toBe('model')
    fireEvent.click(screen.getByRole('switch', { name: 'Use the generic rubric' }))
    expect(rubricOf()).toBe('generic')
    fireEvent.click(screen.getByRole('switch', { name: 'Use the generic rubric' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your rubric' }), {
      target: { value: '- Does it quote the page?' }
    })
    expect(rubricOf()).toEqual({ text: '- Does it quote the page?' })
  })

  it('Discover with a screen: asks nothing about a rubric while it reads no page', () => {
    render(<Harness template="discover" spec={screenedDiscover(ROUTES)} />)
    expect(screen.getByText('Pages to read')).toBeInTheDocument()
    expect(screen.queryByText('Reading pages needs a written rubric')).toBeNull()
  })

  it('Decide: says plainly that it cannot read pages yet', () => {
    render(<Harness template="decide" prompt={`Pick one of ${PAGE}`} />)
    fireEvent.blur(task())
    expect(screen.getByRole('note')).toHaveTextContent('Decide can’t read web pages yet.')
    expect(screen.queryByText('Pages to read')).toBeNull()
    expect(latest!.graph.spec.steps.some((step) => step.web)).toBe(false)
  })
})
