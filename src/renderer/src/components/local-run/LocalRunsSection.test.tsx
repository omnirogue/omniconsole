// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalRunNavigation } from '@/lib/local-run-navigation'
import type * as ConsoleWorkflowClient from '@/lib/console-workflow-client'
import { pipelineFixture } from '../build-review/build-review-test-fixture'
import { LocalRunsSection } from './LocalRunsSection'
import { localRunFixture } from './local-run-test-fixture'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  refreshAll: vi.fn(),
  openTaskPage: vi.fn(),
  state: {} as Record<string, unknown>
}))

vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({ usable: [], loading: false, refresh: vi.fn(async () => []) })
}))
// Why i18n: the worker card draws AgentIcon, whose catalog reads the active language on load.
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, english: string) => english
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: () => <span data-testid="state-dot" />,
  agentStateLabel: (state: string) => state
}))
vi.mock('../activity/activity-terminal-portal', () => ({ setActivityTerminalPortals: vi.fn() }))
vi.mock('../build-review/use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: () => []
}))
vi.mock('@/lib/console-workflow-client', async () => {
  const actual = await vi.importActual<typeof ConsoleWorkflowClient>(
    '@/lib/console-workflow-client'
  )
  return {
    ...actual,
    consoleWorkflowApi: () => ({ templates: async () => ({ ok: true, data: [] }) })
  }
})

const pipeline = pipelineFixture()
const run = localRunFixture()

beforeEach(() => {
  vi.clearAllMocks()
  useLocalRunNavigation.setState({ open: false, workspacePath: null, requestedAt: 0 })
  mocks.state = {
    worktreesByRepo: {},
    folderWorkspaces: [
      {
        id: '1',
        projectGroupId: 'group',
        name: 'Webinar',
        folderPath: '/Users/me/Webinar',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ],
    buildReview: { pipelinesById: { [pipeline.id]: pipeline }, refreshAll: mocks.refreshAll },
    settings: {},
    openTaskPage: mocks.openTaskPage
  }
  mocks.rpc.mockImplementation((_target: unknown, method: string) => {
    if (method === 'localRun.list') {
      return Promise.resolve({ runs: [run] })
    }
    if (method === 'localRun.listDrafts') {
      return Promise.resolve({
        drafts: [
          {
            id: 'draft-1',
            title: 'Saved opener',
            graph: {
              workspacePath: '/Users/me/Webinar',
              nodes: [
                {
                  id: 'step-1',
                  actor: { agent: 'codex' },
                  presetId: 'implement',
                  objective: 'Cut the opener',
                  deps: []
                }
              ]
            },
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    }
    return Promise.resolve({})
  })
})
afterEach(cleanup)

describe('the Local runs section beside console workflows', () => {
  it('lists local runs, Build + Review pipelines and saved graphs', async () => {
    render(<LocalRunsSection onAdmit={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Local runs' })
    await waitFor(() => expect(screen.getByText('/Users/me/Webinar')).toBeInTheDocument())
    expect(screen.getByText(/Build \+ Review/)).toBeInTheDocument()
    expect(screen.getByText('Build a search dialog')).toBeInTheDocument()
    await screen.findByText('Saved opener')
    expect(mocks.refreshAll).toHaveBeenCalled()
  })

  it('draws the canvas for the run a person picks', async () => {
    render(<LocalRunsSection onAdmit={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Running · 3 steps/ }))
    expect(await screen.findByRole('region', { name: 'Graph' })).toBeInTheDocument()
    expect(screen.getByText('Workspace: /Users/me/Webinar')).toBeInTheDocument()
  })

  it('opens a saved graph in draft mode with its steps intact', async () => {
    render(<LocalRunsSection onAdmit={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Saved graph/ }))
    expect(await screen.findByLabelText('Graph name')).toHaveValue('Saved opener')
    expect(screen.getByText('Runs in this folder: /Users/me/Webinar')).toBeInTheDocument()
    expect(screen.getAllByDisplayValue('Cut the opener').length).toBeGreaterThan(0)
  })

  it('seeds a draft on the folder a workspace row asked for', async () => {
    render(<LocalRunsSection onAdmit={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Local runs' })
    useLocalRunNavigation.getState().show('/Users/me/Webinar')
    expect(await screen.findByText('Runs in this folder: /Users/me/Webinar')).toBeInTheDocument()
    // A folder workspace is refused for admission, and told to run locally instead.
    expect(screen.getByRole('alert')).toHaveTextContent('needs a git workspace')
  })
})
