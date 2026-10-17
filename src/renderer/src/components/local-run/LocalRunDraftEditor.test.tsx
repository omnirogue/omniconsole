// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newLocalRunDraft, type LocalRunCanvasDraft } from '@/lib/local-run-draft'
import type * as ConsoleWorkflowClient from '@/lib/console-workflow-client'
import { LocalRunDraftEditor } from './LocalRunDraftEditor'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  templates: vi.fn(),
  save: vi.fn(),
  state: { settings: {} } as Record<string, unknown>
}))

vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({ usable: [], loading: false, refresh: vi.fn(async () => []) })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.state)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: () => <span data-testid="state-dot" />,
  agentStateLabel: (state: string) => state
}))
vi.mock('../build-review/use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: () => []
}))
vi.mock('@/lib/console-workflow-client', async () => {
  const actual = await vi.importActual<typeof ConsoleWorkflowClient>(
    '@/lib/console-workflow-client'
  )
  return { ...actual, consoleWorkflowApi: () => ({ templates: mocks.templates }) }
})

const folder = { path: '/Users/me/Webinar', selector: 'id:folder:1', kind: 'folder' as const }
const repo = {
  path: '/Users/me/omni-ide',
  selector: 'id:repo::/Users/me/omni-ide',
  kind: 'git' as const
}
const workspaces = [
  { value: folder.selector, label: 'Webinar', path: folder.path, kind: 'folder' as const },
  { value: repo.selector, label: 'omni-ide', path: repo.path, kind: 'git' as const }
]

function Harness({
  initial,
  onStarted = vi.fn(),
  onAdmit = vi.fn()
}: {
  initial: LocalRunCanvasDraft
  onStarted?: (run: unknown) => void
  onAdmit?: (composer: unknown) => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <LocalRunDraftEditor
      draft={draft}
      workspaces={workspaces}
      onChange={setDraft}
      onSave={mocks.save}
      onStarted={onStarted}
      onAdmit={onAdmit}
    />
  )
}

function draftWithStep(patch: Partial<LocalRunCanvasDraft> = {}): LocalRunCanvasDraft {
  const draft = newLocalRunDraft(folder, { title: 'Opener', ...patch })
  return {
    ...draft,
    nodes: draft.nodes.map((node) => ({ ...node, objective: 'Cut the opener' }))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.templates.mockResolvedValue({ ok: true, data: [] })
  mocks.save.mockResolvedValue(undefined)
  mocks.rpc.mockImplementation((_target: unknown, method: string) =>
    method === 'localRun.create'
      ? Promise.resolve({ run: { id: 'lrn_new' } })
      : Promise.resolve({ run: { id: 'lrn_new', stage: 'running' } })
  )
})
afterEach(cleanup)

describe('drafting a graph on the canvas', () => {
  it('adds a step, connects it, and sends exactly that graph to the runner', async () => {
    const onStarted = vi.fn()
    render(<Harness initial={draftWithStep()} onStarted={onStarted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    expect(screen.getAllByText('step-2').length).toBeGreaterThan(0)
    // The new step has no objective yet, so running is refused and says why.
    expect(
      screen.getByText(/Every step needs an objective. Missing on: step-2/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run locally' })).toBeDisabled()
    const objectives = screen.getAllByLabelText('Objective')
    fireEvent.change(objectives[1], { target: { value: 'Add the captions' } })
    fireEvent.click(screen.getByLabelText('step-1'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run locally' })).not.toBeDisabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run locally' }))
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    expect(mocks.rpc.mock.calls[0]).toEqual([
      { kind: 'local' },
      'localRun.create',
      {
        graph: {
          workspacePath: '/Users/me/Webinar',
          maxConcurrent: 3,
          nodes: [
            {
              id: 'step-1',
              actor: { agent: 'codex' },
              presetId: 'implement',
              objective: 'Cut the opener',
              deps: []
            },
            {
              id: 'step-2',
              actor: { agent: 'codex' },
              presetId: 'implement',
              objective: 'Add the captions',
              deps: ['step-1']
            }
          ]
        }
      }
    ])
    expect(mocks.rpc.mock.calls[1]).toEqual([
      { kind: 'local' },
      'localRun.start',
      { id: 'lrn_new' }
    ])
    expect(onStarted).toHaveBeenCalledWith({ id: 'lrn_new', stage: 'running' })
  })

  it('refuses a circular link at the moment it is drawn', () => {
    render(<Harness initial={draftWithStep()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    fireEvent.click(screen.getByLabelText('step-1'))
    fireEvent.click(screen.getByLabelText('step-2'))
    expect(screen.getByText(/Steps cannot depend on each other in a circle/)).toBeInTheDocument()
  })

  it('seeds a template’s steps, each carrying the objective typed once', () => {
    render(<Harness initial={draftWithStep()} />)
    fireEvent.change(screen.getByLabelText('What to do'), {
      target: { value: 'Three cuts of the opener' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use this template' }))
    for (const step of ['research', 'plan', 'produce', 'review', 'verify']) {
      expect(screen.getAllByText(step).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByDisplayValue('Three cuts of the opener')).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Run locally' })).not.toBeDisabled()
  })

  it('saves the graph beside automations without starting anything', async () => {
    render(<Harness initial={draftWithStep()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0][0]).toMatchObject({
      title: 'Opener',
      graph: { workspacePath: '/Users/me/Webinar' }
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses to run a fleet-placed step here and names it', () => {
    const draft = draftWithStep()
    render(
      <Harness
        initial={{
          ...draft,
          nodes: draft.nodes.map((node) => ({ ...node, placement: 'fleet' as const }))
        }}
      />
    )
    expect(screen.getByText(/Fleet steps are admitted through the console/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run locally' })).toBeDisabled()
  })
})

describe('admitting a graph through the console', () => {
  it('refuses a folder workspace, names the folder and points at running it locally', () => {
    render(<Harness initial={draftWithStep()} />)
    const refusal = screen.getByRole('alert')
    expect(refusal).toHaveTextContent('Admitting work through the console needs a git workspace')
    expect(refusal).toHaveTextContent('/Users/me/Webinar')
    expect(screen.queryByRole('button', { name: 'Admit…' })).not.toBeInTheDocument()
    expect(mocks.templates).not.toHaveBeenCalled()
  })

  it('hands a git workspace’s stages to the console composer', async () => {
    const onAdmit = vi.fn()
    render(
      <Harness
        initial={draftWithStep({
          workspacePath: repo.path,
          workspaceSelector: repo.selector,
          workspaceKind: 'git'
        })}
        onAdmit={onAdmit}
      />
    )
    await waitFor(() => expect(mocks.templates).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Admit…' }))
    expect(onAdmit).toHaveBeenCalledTimes(1)
    expect(onAdmit.mock.calls[0][0]).toMatchObject({
      taskId: '',
      stages: [{ key: 'step-1', prompt: 'Cut the opener', placement: 'local' }]
    })
  })

  it('says the server has no templates rather than offering local ones', async () => {
    mocks.templates.mockResolvedValue({
      ok: false,
      error: { code: 'capability_unavailable', message: 'Templates are unavailable.' }
    })
    render(
      <Harness
        initial={draftWithStep({
          workspacePath: repo.path,
          workspaceSelector: repo.selector,
          workspaceKind: 'git'
        })}
      />
    )
    await screen.findByText(/The server did not provide templates for admitted work/)
    expect(screen.queryByText('Fan-out → Synthesize')).not.toBeInTheDocument()
  })
})
