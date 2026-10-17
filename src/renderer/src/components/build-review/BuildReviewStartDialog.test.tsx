// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BuildReviewStartDialog from './BuildReviewStartDialog'
import { BuildReviewStartForm } from './BuildReviewStartForm'
import { REVIEW_RUBRIC_PRESETS } from '../../../../shared/review-rubrics'
import type * as RunOnHosts from '../local-workflows/workflow-run-on-hosts'

const general = REVIEW_RUBRIC_PRESETS[0]

const mocks = vi.hoisted(() => {
  const catalogModel = (id: string) => ({ id, label: id, options: [], isDefault: true })
  const agent = (id: string, models: string[]) => ({
    id,
    label: id,
    models: models.map(catalogModel),
    modelsProbed: true
  })
  const hostAgents = [agent('codex', ['gpt-5.5', 'review-model']), agent('claude', ['opus'])]
  return {
    start: vi.fn(),
    startOptions: [] as unknown[],
    anchor: vi.fn(),
    close: vi.fn(),
    objective: undefined as string | undefined,
    worktree: 'repo::/workspace',
    folders: [] as unknown[],
    agent,
    hostAgents,
    usable: hostAgents as unknown[],
    loading: false,
    worktreeIds: [] as (string | null)[],
    modes: [] as (string | undefined)[]
  }
})
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: (worktreeId: string | null, _taskId?: string, mode?: string) => {
    mocks.worktreeIds.push(worktreeId)
    mocks.modes.push(mode)
    return { usable: mocks.usable, loading: mocks.loading, refresh: vi.fn(async () => []) }
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      buildReview: {
        startDialog: { open: true, worktree: mocks.worktree, objective: mocks.objective },
        // Why a wrapper: the dialog always asks for no reveal; assertions stay on the request.
        start: (request: unknown, options: unknown) => {
          mocks.startOptions.push(options)
          return mocks.start(request)
        },
        closeStartDialog: mocks.close
      },
      folderWorkspaces: mocks.folders
    })
}))
vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [
    { id: 'repo::/workspace', path: '/workspace', branch: 'feature' },
    { id: 'ssh:box::/srv/app', path: '/srv/app', branch: 'main' }
  ]
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))
vi.mock('@/lib/build-review-entry', () => ({ anchorBuildReviewRun: mocks.anchor }))
vi.mock('../local-workflows/workflow-run-on-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof RunOnHosts>()),
  useWorkflowRunOnHosts: () => ({ hosts: [], targets: [] })
}))
vi.mock('./use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: () => []
}))
vi.mock('../local-workflows/workflow-presets', () => ({
  WorkflowPresetIcon: ({ preset }: { preset: string }) => (
    <span data-testid="preset-icon" data-preset={preset} />
  )
}))
// The translate mock leaves `{{count}}` in place, so every count button shares one name.
const reviewerCount = (count: number) =>
  screen.getAllByRole('button', { name: '{{count}} reviewer(s)' })[count - 1]!
const roundCount = (count: number) =>
  screen.getAllByRole('button', { name: '{{count}} round(s)' })[count - 1]!
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.start.mockResolvedValue(undefined)
  mocks.worktree = 'repo::/workspace'
  mocks.objective = undefined
  mocks.startOptions = []
  mocks.folders = []
  mocks.usable = mocks.hostAgents
  mocks.loading = false
  mocks.worktreeIds = []
  mocks.modes = []
})
describe('BuildReviewStartDialog', () => {
  it('submits the runtime selector, trimmed objective and configured defaults', async () => {
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: '  Build search  ' } })
    fireEvent.change(screen.getByLabelText('Review focus (optional)'), {
      target: { value: '  Accessibility  ' }
    })
    fireEvent.click(screen.getAllByLabelText('Model')[0])
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-5.5' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith({
        worktree: 'id:repo::/workspace',
        objective: 'Build search',
        builder: { agent: 'codex', model: 'gpt-5.5' },
        // The default panel: Grok is not on this host, and Codex moves off the builder's model.
        reviewers: [
          { agent: 'claude', model: 'opus', effort: 'high', rubric: general },
          { agent: 'codex', model: 'review-model', rubric: general }
        ],
        maxReviewRounds: 3,
        // Always sent, even unchanged: the host never infers the fleet default from silence.
        runsOn: 'fleet',
        reviewFocus: 'Accessibility'
      })
    )
  })
  it('opens the started run as a tab in the picked workspace instead of the page', async () => {
    mocks.start.mockResolvedValue({ id: 'brp_1', objective: 'Build search' })
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build search' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.anchor).toHaveBeenCalledWith('repo::/workspace', {
        id: 'brp_1',
        objective: 'Build search'
      })
    )
    expect(mocks.startOptions).toEqual([{ reveal: false }])
  })
  it('hands an SSH pick to the tab by its workspace id and keeps a prefilled objective', async () => {
    mocks.worktree = 'ssh:box::/srv/app'
    mocks.objective = 'Fix the retry'
    mocks.start.mockResolvedValue({ id: 'brp_2', objective: 'Fix the retry' })
    render(<BuildReviewStartDialog />)
    expect(screen.getByLabelText('Objective')).toHaveValue('Fix the retry')
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() => expect(mocks.anchor).toHaveBeenCalledOnce())
    expect(mocks.start.mock.calls[0]![0].worktree).toBe('id:ssh:box::/srv/app')
    expect(mocks.anchor.mock.calls[0]![0]).toBe('ssh:box::/srv/app')
  })
  it('asks for Build + Review availability and draws quiet rows, not framed fieldsets', () => {
    render(<BuildReviewStartDialog />)
    expect(new Set(mocks.modes)).toEqual(new Set(['build-review']))
    expect(document.querySelector('legend')).toBeNull()
    expect(screen.getByRole('group', { name: 'Builder' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Reviewer 1' })).toBeInTheDocument()
  })
  it('shows the wrench and the workspace picker in the standalone dialog', () => {
    render(<BuildReviewStartDialog />)
    expect(screen.getByTestId('preset-icon')).toHaveAttribute('data-preset', 'build-review')
    expect(screen.getByLabelText('Worktree or folder')).toBeInTheDocument()
  })

  it('adds independent reviewer models, shrinks seats from the end, and submits the round limit', async () => {
    render(<BuildReviewStartDialog />)
    expect(screen.getByLabelText('Objective')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Describe the result')
    )
    expect(screen.getByLabelText('Review focus (optional)')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Tell reviewers')
    )
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build search' } })
    // An explicit builder model lets another Codex model review; "Agent default" could be any.
    fireEvent.click(screen.getAllByLabelText('Model')[0])
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-5.5' }))
    fireEvent.click(reviewerCount(2))
    fireEvent.click(screen.getAllByLabelText('Model')[2])
    fireEvent.click(await screen.findByRole('option', { name: 'review-model' }))
    fireEvent.click(roundCount(5))
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewers: [
            { agent: 'claude', model: 'opus', effort: 'high', rubric: general },
            { agent: 'codex', model: 'review-model', rubric: general }
          ],
          maxReviewRounds: 5
        })
      )
    )
    fireEvent.click(reviewerCount(1))
    expect(screen.getAllByLabelText('Model')).toHaveLength(2)
    expect(screen.getAllByLabelText('Model')[1]).toHaveTextContent('opus')
    expect(screen.queryByRole('button', { name: 'Add reviewer' })).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('gives count-button reviewer seats distinct exact models from the host', async () => {
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build search' } })
    fireEvent.click(screen.getAllByLabelText('Model')[0])
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-5.5' }))
    fireEvent.click(reviewerCount(3))
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          // The host's third model is the builder's own, so no third seat is proposed.
          reviewers: [
            { agent: 'claude', model: 'opus', effort: 'high', rubric: general },
            { agent: 'codex', model: 'review-model', rubric: general }
          ]
        })
      )
    )
  })

  it('submits the model a Sonnet-only host lists, never the hard-coded opus default', async () => {
    mocks.usable = [mocks.agent('claude', ['sonnet']), mocks.agent('codex', ['gpt-only'])]
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    expect(mocks.start.mock.calls[0]![0].reviewers).toEqual([
      { agent: 'claude', model: 'sonnet', rubric: general }
    ])
  })

  it('blocks Start and names the gap when the host reports no catalog', () => {
    mocks.usable = []
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review me' } })
    expect(screen.getByRole('alert')).toHaveTextContent('has not reported which agents and models')
    const start = screen.getByRole('button', { name: 'Start Build + Review' })
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('blocks Start while host discovery is still loading', () => {
    mocks.usable = []
    mocks.loading = true
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review me' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Checking which models')
    expect(screen.getByRole('button', { name: 'Start Build + Review' })).toBeDisabled()
  })

  it('repairs a seat added during a discovery outage once the host answers', async () => {
    mocks.usable = []
    const { rerender } = render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review me' } })
    fireEvent.click(reviewerCount(2))
    expect(screen.getByRole('button', { name: 'Start Build + Review' })).toBeDisabled()
    mocks.usable = mocks.hostAgents
    rerender(<BuildReviewStartDialog />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    // With the builder on "Agent default" no Codex model may review it: one reviewer, and a note.
    expect(
      screen.getByText(/reviewer\(s\) here can be shown not to be the builder/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewers: [{ agent: 'claude', model: 'opus', effort: 'high', rubric: general }]
        })
      )
    )
  })

  it('reconciles seats against the remote host the workspace runs on', async () => {
    mocks.worktree = 'ssh:box::/srv/app'
    mocks.usable = [mocks.agent('claude', ['sonnet-remote'])]
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    expect(mocks.worktreeIds).toContain('ssh:box::/srv/app')
    expect(mocks.start.mock.calls[0]![0].reviewers).toEqual([
      { agent: 'claude', model: 'sonnet-remote', rubric: general }
    ])
  })

  it('offers only the valid round limits, three by default', () => {
    render(<BuildReviewStartDialog />)
    const rounds = screen.getAllByRole('button', { name: '{{count}} round(s)' })
    expect(rounds).toHaveLength(10)
    expect(roundCount(3)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('group', { name: 'Maximum review rounds' })).toBeInTheDocument()
  })

  it('keeps the task link under Advanced and blocks Start on a malformed ID', async () => {
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build' } })
    expect(screen.queryByLabelText('Link a task (optional)')).toBeNull()
    expect(screen.queryByText(/omnios card/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.change(screen.getByLabelText('Link a task (optional)'), {
      target: { value: 'not-a-task' }
    })
    expect(screen.getByText(/starts with btk_/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start Build + Review' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Link a task (optional)'), {
      target: { value: 'btk_12345678' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ hubTaskId: 'btk_12345678' })
      )
    )
  })

  it('accepts an already-prefixed selector without double-prefixing', async () => {
    mocks.worktree = 'id:repo::/workspace'
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: 'id:repo::/workspace' })
      )
    )
  })
  it('requires an objective and shows a failed start without closing', async () => {
    mocks.start.mockRejectedValue(new Error('Coordinator unavailable'))
    render(<BuildReviewStartDialog />)
    expect(screen.getByRole('button', { name: 'Start Build + Review' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Coordinator unavailable')
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.anchor).not.toHaveBeenCalled()
  })
  it('refuses a second run on a busy workspace in plain words', async () => {
    mocks.start.mockRejectedValue(
      new Error('Pipeline brp_0123456789ab is still building in this workspace.')
    )
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'A Build + Review run is already working in this workspace. Stop it or wait for it to finish.'
    )
    expect(alert).not.toHaveTextContent('Pipeline')
    expect(alert).not.toHaveTextContent('brp_')
  })
  it('submits folder workspace keys through the same runtime selector', async () => {
    mocks.folders = [
      { id: 'folder-1', name: 'Scratch', folderPath: '/scratch', projectGroupId: 'group-1' }
    ]
    mocks.worktree = 'folder:folder-1'
    render(<BuildReviewStartDialog />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build in a folder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: 'id:folder:folder-1' })
      )
    )
  })

  it('inside a conversation uses the tab workspace without asking for one', async () => {
    render(
      <BuildReviewStartForm
        initialWorktree="repo::/workspace"
        pending={false}
        setPending={vi.fn()}
        onStart={mocks.start}
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('Worktree or folder')).toBeNull()
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: 'id:repo::/workspace', objective: 'Build' })
      )
    )
  })

  it('inside a conversation ignores a workspace a saved draft picked elsewhere', async () => {
    render(
      <BuildReviewStartForm
        initialWorktree="repo::/workspace"
        initialDraft={{
          worktree: 'id:ssh:box::/srv/app',
          objective: 'Saved objective',
          reviewFocus: '',
          hubTaskId: '',
          builder: { agent: 'codex' },
          reviewers: [{ id: 0, choice: { agent: 'claude', model: 'opus' } }],
          maxReviewRounds: 2
        }}
        pending={false}
        setPending={vi.fn()}
        onStart={mocks.start}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Objective')).toHaveValue('Saved objective')
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: 'id:repo::/workspace', maxReviewRounds: 2 })
      )
    )
    expect(mocks.worktreeIds).not.toContain('ssh:box::/srv/app')
  })

  it('says why Start is unavailable when the tab workspace cannot run it', () => {
    render(
      <BuildReviewStartForm
        initialWorktree="gone::/nowhere"
        pending={false}
        setPending={vi.fn()}
        onStart={mocks.start}
        onCancel={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Build' } })
    expect(screen.getByRole('alert')).toHaveTextContent('not available for Build + Review')
    expect(screen.getByRole('button', { name: 'Start Build + Review' })).toBeDisabled()
  })

  it('sends a saved named host with the Start and shows a named-host refusal in the form', async () => {
    mocks.start.mockRejectedValue(
      new Error(
        'This OmniConsole cannot run Build + Review on a named host. Update it, or choose the fleet or this computer.'
      )
    )
    const onDraftChange = vi.fn()
    render(
      <BuildReviewStartForm
        initialWorktree="repo::/workspace"
        initialDraft={{
          worktree: 'id:repo::/workspace',
          objective: 'Saved objective',
          reviewFocus: '',
          hubTaskId: '',
          builder: { agent: 'codex' },
          reviewers: [{ id: 0, choice: { agent: 'claude', model: 'opus' } }],
          maxReviewRounds: 2,
          runsOn: 'fleet',
          runsOnHost: 'mw0004',
          runsOnHostId: 'ssh:t2'
        }}
        onDraftChange={onDraftChange}
        pending={false}
        setPending={vi.fn()}
        onStart={mocks.start}
        onCancel={vi.fn()}
      />
    )
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ runsOn: 'fleet', runsOnHost: 'mw0004', runsOnHostId: 'ssh:t2' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start Build + Review' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ runsOn: 'fleet', runsOnHost: 'mw0004', runsOnHostId: 'ssh:t2' })
      )
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cannot run Build + Review on a named host'
    )
  })
})
