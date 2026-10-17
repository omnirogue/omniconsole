// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProjectAgent } from '../../../../shared/project-settings'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  workspace: 'repo::/work/checkout' as string | null,
  agents: [] as ProjectAgent[],
  rememberedId: 'default',
  select: vi.fn(),
  prepare: vi.fn(),
  call: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: unknown) => unknown) => select(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: Object.assign(
    (select: (state: unknown) => unknown) => select({ metadata: {} }),
    {
      getState: () => ({ metadata: {} })
    }
  )
}))
vi.mock('@/lib/project-launch', () => ({
  launchProjectIn: () => ({
    settings: { repos: [{ gitIdentity: 'example/project' }], agents: mocks.agents }
  }),
  projectWorkspaceIn: () => mocks.workspace
}))
vi.mock('@/lib/company-session-workspace', () => ({ ensureCompanySessionWorkspace: mocks.prepare }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('../agent/AgentTemplateSelect', () => ({
  AgentTemplateSelect: (props: unknown) => {
    mocks.select(props)
    return null
  }
}))
vi.mock('../native-chat/SessionPrepStatus', () => ({ SessionPrepStatus: () => null }))
vi.mock('../native-chat/session-prep-composer-state', () => ({ noteSessionPrepBatch: vi.fn() }))
vi.mock('../sidebar/session-folders/new-conversation/launch-context', () => ({
  rememberedTemplate: () => ({ id: null }),
  rememberedTemplateId: () => mocks.rememberedId,
  rememberTemplate: vi.fn()
}))
import { WorkDispatchComposer } from './WorkDispatchComposer'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.workspace = 'repo::/work/checkout'
  mocks.agents = []
  mocks.rememberedId = 'default'
  mocks.state = {
    activeOrcaProfileId: 'profile',
    repos: [{ id: 'repo', executionHostId: 'runtime:studio' }],
    worktreesByRepo: { repo: [{ id: mocks.workspace, repoId: 'repo', hostId: 'runtime:studio' }] }
  }
})

it.each(['project-only', 'ghost', 'default'])(
  'shows and requests the effective project agent for remembered %s',
  async (rememberedId) => {
    mocks.rememberedId = rememberedId
    mocks.agents = [
      {
        templateId: 'reviewer',
        name: 'Primary',
        digest: 'a'.repeat(12),
        instructions: 'Project primary'
      },
      {
        templateId: 'project-only',
        name: 'Portable agent',
        digest: 'b'.repeat(12),
        instructions: 'Project custom'
      }
    ]
    mocks.workspace = 'folder:plain'
    mocks.state.folderWorkspaces = [
      { id: 'plain', projectGroupId: 'work', executionHostId: 'local' }
    ]
    mocks.call.mockResolvedValue({})
    render(
      <TooltipProvider>
        <WorkDispatchComposer project={{ folderId: 'project', name: 'Website' }} />
      </TooltipProvider>
    )
    const selected = rememberedId === 'project-only' ? 'project-only' : 'reviewer'
    expect(mocks.select).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: selected, projectAgents: mocks.agents })
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Prepare the feature' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalled())
    expect(mocks.call.mock.calls[0]?.[2].agentTemplateId).toBe(
      rememberedId === 'project-only' ? rememberedId : undefined
    )
  }
)
afterEach(cleanup)

it.each(['paired', 'missing'])(
  'keeps the draft and does not fall back to Work for a %s project checkout',
  async (kind) => {
    if (kind === 'missing') {
      mocks.workspace = null
    }
    render(
      <TooltipProvider>
        <WorkDispatchComposer project={{ folderId: 'project', name: 'Website' }} />
      </TooltipProvider>
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Prepare the feature' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('local or SSH checkout')
    )
    expect((input as HTMLTextAreaElement).value).toBe('Prepare the feature')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  }
)

it('sends an attached local folder by its catalog id and keeps the controller project id', async () => {
  mocks.workspace = 'folder:plain'
  mocks.state.folderWorkspaces = [{ id: 'plain', projectGroupId: 'work', executionHostId: 'local' }]
  mocks.call.mockResolvedValue({})
  render(
    <TooltipProvider>
      <WorkDispatchComposer project={{ folderId: 'project', name: 'Website' }} />
    </TooltipProvider>
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Prepare the feature' } })
  fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'sessionPrep.request',
      expect.objectContaining({
        defaultFolder: 'project',
        source: expect.objectContaining({ worktreeId: 'plain' })
      })
    )
  )
})

it('submits each Need Speed row independently with project provenance and distinct retry identities', async () => {
  mocks.workspace = 'folder:plain'
  mocks.state.folderWorkspaces = [{ id: 'plain', projectGroupId: 'work', executionHostId: 'local' }]
  mocks.call.mockImplementation(async (_target, method, params) =>
    method === 'status.get'
      ? { capabilities: ['session-prep.routing.v1'] }
      : { batchId: params.requestId }
  )
  render(
    <WorkDispatchComposer
      project={{ folderId: 'independent-project', name: 'Website' }}
      independentObjectives
    />
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 1' }), {
    target: { value: 'Audit login with opus high' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add prompt' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 2' }), {
    target: { value: 'Plan the newsletter' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
  await waitFor(() => expect(screen.getAllByText('Accepted')).toHaveLength(2))
  const requests = mocks.call.mock.calls
    .filter(([, method]) => method === 'sessionPrep.request')
    .map(([, , params]) => params)
  expect(requests.map((request) => request.text)).toEqual([
    'Audit login with opus high',
    'Plan the newsletter'
  ])
  expect(new Set(requests.map((request) => request.requestId)).size).toBe(2)
  expect(requests[0]).toMatchObject({
    defaultFolder: 'independent-project',
    source: { worktreeId: 'plain', entryPoint: 'need-speed', routingMode: 'live' }
  })
})

it('honors an explicitly selected source workspace instead of substituting the Work root', async () => {
  mocks.state.folderWorkspaces = [
    { id: 'chosen', projectGroupId: 'work', executionHostId: 'local' }
  ]
  mocks.call.mockImplementation(async (_target, method, params) =>
    method === 'status.get'
      ? { capabilities: ['session-prep.routing.v1'] }
      : { batchId: params.requestId }
  )
  render(<WorkDispatchComposer sourceWorktreeId="folder:chosen" independentObjectives />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 1' }), {
    target: { value: 'Review this workspace' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
  await waitFor(() => expect(screen.getByText('Accepted')).toBeDefined())
  expect(
    mocks.call.mock.calls.find(([, method]) => method === 'sessionPrep.request')?.[2].source
      .worktreeId
  ).toBe('chosen')
  expect(mocks.prepare).not.toHaveBeenCalled()
})

it('refuses an older runtime before any workspace or prompt is submitted', async () => {
  mocks.call.mockResolvedValue({ capabilities: [] })
  render(
    <WorkDispatchComposer
      project={{ folderId: 'old-runtime-project', name: 'Website' }}
      independentObjectives
    />
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 1' }), {
    target: { value: 'Review launch' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Update OmniConsole'))
  expect(mocks.call).toHaveBeenCalledTimes(1)
  expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'status.get', {})
  expect(mocks.prepare).not.toHaveBeenCalled()
})

it('does not prepare or submit into a profile selected while capability checking is in flight', async () => {
  mocks.call.mockImplementation(async () => {
    mocks.state.activeOrcaProfileId = 'changed-profile'
    return { capabilities: ['session-prep.routing.v1'] }
  })
  const view = render(
    <WorkDispatchComposer
      project={{ folderId: 'switching-profile-project', name: 'Website' }}
      independentObjectives
    />
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 1' }), {
    target: { value: 'Review launch' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
  mocks.state.activeOrcaProfileId = 'profile'
  view.rerender(
    <WorkDispatchComposer
      project={{ folderId: 'switching-profile-project', name: 'Website' }}
      independentObjectives
    />
  )
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('original profile'))
  expect(mocks.call).toHaveBeenCalledTimes(1)
  expect(mocks.prepare).not.toHaveBeenCalled()
})
