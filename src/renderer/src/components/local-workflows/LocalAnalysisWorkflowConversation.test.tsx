// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAnalysisWorkflowConversation } from './LocalAnalysisWorkflowConversation'
import type { LocalWorkflowController } from './local-workflow-controller'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { workflowCatalog, workflowDraft, workflowView } from './local-workflow-ui.fixtures'
import { discoverRunView } from './local-workflow-run.fixtures'
import { createLocalWorkflowAuditDraft } from '../../../../shared/workflow-audit-draft'

const { save, prepareTurn, create, title, openLocation, openTerminal, toastError, openBuild } =
  vi.hoisted(() => ({
    save: vi.fn(),
    prepareTurn: vi.fn(),
    create: vi.fn(),
    title: vi.fn(),
    openLocation: vi.fn(),
    openTerminal: vi.fn(),
    toastError: vi.fn(),
    openBuild: vi.fn()
  }))
vi.mock('@/lib/local-workflow-conversation', () => ({
  updateLocalWorkflowConversation: save,
  prepareLocalWorkflowTurn: prepareTurn,
  createLocalWorkflowConversation: create,
  titleLocalWorkflowConversation: title
}))
vi.mock('@/lib/build-review-entry', () => ({ openBuildReview: openBuild }))
vi.mock('./local-workflow-open-location', () => ({
  openLocalWorkflowLocation: openLocation,
  workflowLocationProblem: (outcome: string, location: string) =>
    outcome === 'opened' ? undefined : `${location}: ${outcome}`
}))
vi.mock('../build-review/open-worker-terminal', () => ({ openWorkerTerminal: openTerminal }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => {
    throw new Error('Use supplied workflow catalog')
  }
}))
vi.mock('../build-review/use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: () => {
    throw new Error('Use supplied workflow catalog')
  }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const tab = {
  id: 'tab-1',
  worktreeId: 'workspace-1',
  localWorkflow: { preset: 'council', prompt: 'Saved request' }
} as TerminalTab
function controller(): LocalWorkflowController {
  return {
    catalog: workflowCatalog,
    defaults: workflowDraft(),
    graphTeam: [
      { id: 'claude', agent: 'claude', accountId: 'claude-account' },
      { id: 'codex', agent: 'codex', accountId: 'codex-account' },
      { id: 'grok', agent: 'grok', accountId: 'grok-account' }
    ],
    scopeLabel: 'Workspace',
    scopeOptions: [],
    maxConcurrency: 4,
    start: vi.fn().mockResolvedValue({ executionId: 'execution-1' }),
    control: vi.fn().mockResolvedValue(undefined)
  }
}
const running = { ...tab, localWorkflow: { ...tab.localWorkflow!, executionId: 'execution-1' } }

describe('analysis workflow conversation', () => {
  it('starts Audit without replacing its draft with a Discover graph', async () => {
    const draft = createLocalWorkflowAuditDraft('Audit these records')
    draft.audit!.sourceFile = '/corpus/records.jsonl'
    const codex = workflowDraft().seats.find((seat) => seat.agent === 'codex')!
    draft.seats = [codex]
    const auditTab = {
      ...tab,
      localWorkflow: { preset: 'discover' as const, prompt: draft.prompt, draft }
    }
    const host = {
      ...controller(),
      auditSupport: { version: 1 as const },
      auditTeam: workflowDraft().seats
    }
    render(<LocalAnalysisWorkflowConversation tab={auditTab} controller={host} />)
    const runAudit = screen.getByRole('button', { name: 'Run Audit' })
    expect(runAudit).toBeEnabled()
    fireEvent.click(runAudit)
    await waitFor(() => expect(host.start).toHaveBeenCalledTimes(1))
    const started = vi.mocked(host.start).mock.calls[0][0]
    expect(started.audit).toEqual(draft.audit)
    expect(started.graph).toBeUndefined()
    expect(started.runsOn).toBe('local')
    expect(started.seats).toEqual([codex])
  })

  it('refuses Audit on a host that does not advertise support', () => {
    const draft = createLocalWorkflowAuditDraft('Audit these records')
    draft.audit!.sourceFile = '/corpus/records.jsonl'
    const auditTab = {
      ...tab,
      localWorkflow: { preset: 'discover' as const, prompt: draft.prompt, draft }
    }
    const host = { ...controller(), auditTeam: workflowDraft().seats }
    render(<LocalAnalysisWorkflowConversation tab={auditTab} controller={host} />)
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Update this computer’s runtime')
    expect(host.start).not.toHaveBeenCalled()
  })

  it('uses the Audit team when a frozen-only model is absent from the graph team', async () => {
    const draft = createLocalWorkflowAuditDraft('Audit these records')
    draft.audit!.sourceFile = '/corpus/records.jsonl'
    const grok = workflowDraft().seats.find((seat) => seat.agent === 'grok')!
    draft.seats = [grok]
    const auditTab = {
      ...tab,
      localWorkflow: { preset: 'discover' as const, prompt: draft.prompt, draft }
    }
    const host = {
      ...controller(),
      auditSupport: { version: 1 as const },
      graphTeam: [],
      auditTeam: [grok],
      catalog: workflowCatalog.map((entry) => ({
        ...entry,
        streamUnavailableReason: 'Streaming unavailable'
      }))
    }
    render(<LocalAnalysisWorkflowConversation tab={auditTab} controller={host} />)
    const runAudit = screen.getByRole('button', { name: 'Run Audit' })
    expect(runAudit).toBeEnabled()
    fireEvent.click(runAudit)
    await waitFor(() => expect(host.start).toHaveBeenCalledTimes(1))
    expect(vi.mocked(host.start).mock.calls[0][0].seats).toEqual([grok])
  })

  it('hides Save on a completed execution when an older preload lacks the host action', () => {
    const view = {
      ...workflowView(),
      state: 'completed' as const,
      result: { markdown: 'Accepted result', sources: [], coverage: [] }
    }
    Object.assign(window, { api: { runtime: {} } })
    render(
      <LocalAnalysisWorkflowConversation tab={running} controller={{ ...controller(), view }} />
    )
    expect(screen.getByText('Accepted result')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save as file…' })).toBeNull()
  })

  it('starts the Council template as a workflow graph, then names the tab after the request', async () => {
    const host = controller()
    render(<LocalAnalysisWorkflowConversation tab={tab} controller={host} />)
    expect(screen.getByLabelText('What should the workflow work on?')).toHaveValue('Saved request')
    // The graph is drawn before anything runs: three steps, answers → rankings → chairman.
    expect(screen.getByRole('button', { name: /First opinions/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /Peer rankings/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /Chairman's answer/ })).toBeVisible()
    expect(host.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(host.start).toHaveBeenCalledTimes(1))
    const started = vi.mocked(host.start).mock.calls[0][0]
    expect(started.prompt).toBe('Saved request')
    expect(started.graph?.spec.template).toBe('council')
    expect(started.graph?.team.map((seat) => seat.agent)).toEqual(['claude', 'codex', 'grok'])
    // Every family this computer can run answers; Gemini is not set up here.
    expect(started.graph?.spec.steps[0].agents.map((agent) => agent.route)).toEqual([
      'claude',
      'codex',
      'grok'
    ])
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'workspace-1',
        'tab-1',
        expect.objectContaining({ executionId: 'execution-1', prompt: 'Saved request' })
      )
    )
    expect(title).toHaveBeenCalledWith('tab-1', 'Saved request')
  })

  it('replaces an older Council draft with the graph template instead of starting it', async () => {
    const host = controller()
    const early = {
      ...tab,
      localWorkflow: {
        ...tab.localWorkflow!,
        draft: { ...workflowDraft(), seats: [], council: { memberIds: [] } }
      }
    }
    render(<LocalAnalysisWorkflowConversation tab={early} controller={host} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(host.start).toHaveBeenCalledTimes(1))
    expect(vi.mocked(host.start).mock.calls[0][0].graph?.spec.steps.map((step) => step.id)).toEqual(
      ['answer', 'rank', 'chair']
    )
  })

  it('restores an execution before allowing another Start, even if projection has not arrived', () => {
    const host = controller()
    const { rerender } = render(
      <LocalAnalysisWorkflowConversation tab={running} controller={host} />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Restoring workflow execution')
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    host.view = { ...workflowView(), executionId: 'different-execution' }
    rerender(<LocalAnalysisWorkflowConversation tab={running} controller={host} />)
    expect(screen.getByRole('status')).toHaveTextContent('Restoring workflow execution')
    expect(host.start).not.toHaveBeenCalled()
  })

  it('sends the host execution ID and fence for controls without changing the saved anchor', async () => {
    const host = { ...controller(), view: workflowView() }
    render(<LocalAnalysisWorkflowConversation tab={running} controller={host} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(host.control).toHaveBeenCalledWith('execution-1', 2, 'stop'))
    expect(save).not.toHaveBeenCalled()
    expect(host.start).not.toHaveBeenCalled()
  })

  it('reads call logs through the host for the current execution only', async () => {
    const readCall = vi
      .fn()
      .mockResolvedValue({ stdout: 'host log', stderr: '', outputTruncated: false })
    const host = { ...controller(), view: workflowView(), readCall }
    render(<LocalAnalysisWorkflowConversation tab={running} controller={host} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(readCall).toHaveBeenCalledWith('execution-1', 'answers/seat-1'))
    expect(await screen.findByText('host log')).toBeVisible()
  })

  it("opens a working agent's own terminal from its call, and only when it has one", async () => {
    openTerminal.mockResolvedValue(undefined)
    const view = workflowView()
    view.calls = [{ ...view.calls[0], transport: 'terminal', terminalHandle: 'term_worker_1' }]
    const host = { ...controller(), view }
    const { rerender } = render(
      <LocalAnalysisWorkflowConversation tab={running} controller={host} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(openTerminal).toHaveBeenCalledWith('term_worker_1'))
    // A released worker terminal is closed; the view carries no handle and offers no button.
    const released = workflowView()
    released.calls = [{ ...released.calls[0], transport: 'terminal' }]
    rerender(
      <LocalAnalysisWorkflowConversation tab={running} controller={{ ...host, view: released }} />
    )
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
  })

  it('says why a worker terminal did not open', async () => {
    openTerminal.mockRejectedValue(new Error('Terminal term_worker_1 was not found.'))
    const view = workflowView()
    view.calls = [{ ...view.calls[0], transport: 'terminal', terminalHandle: 'term_worker_1' }]
    render(
      <LocalAnalysisWorkflowConversation tab={running} controller={{ ...controller(), view }} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Terminal term_worker_1 was not found.'
    )
  })

  it('sends a follow-up to the host-selected model without starting another workflow', async () => {
    const view = {
      ...workflowView(),
      state: 'completed' as const,
      actions: [],
      result: { markdown: 'Verified result', sources: [], coverage: [] },
      followUpSeat: {
        id: 'seat-1',
        agent: 'claude' as const,
        accountId: 'claude-work',
        model: 'claude-opus-5',
        effort: 'high',
        lineage: 'anthropic' as const,
        policyRevision: 'fixture-v1'
      }
    }
    const host = { ...controller(), view, followUp: vi.fn().mockResolvedValue(undefined) }
    render(<LocalAnalysisWorkflowConversation tab={running} controller={host} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask a follow-up' }))
    fireEvent.change(screen.getByLabelText('Follow up with Council'), {
      target: { value: 'What changed?' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }))
    await waitFor(() =>
      expect(host.followUp).toHaveBeenCalledWith('execution-1', 'What changed?', undefined)
    )
    expect(prepareTurn).not.toHaveBeenCalled()
    expect(host.start).not.toHaveBeenCalled()
  })

  it('opens a Build + Review conversation briefed with a Discover fix', () => {
    const discoverTab = {
      ...running,
      localWorkflow: { ...running.localWorkflow!, preset: 'discover' as const }
    }
    const host = { ...controller(), view: discoverRunView() }
    render(<LocalAnalysisWorkflowConversation tab={discoverTab} controller={host} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fix with Build + Review' }))
    // Through the one Build + Review entry, which picks a tab or its dialog.
    expect(openBuild).toHaveBeenCalledWith('workspace-1', { prompt: expect.any(String) })
    expect(create).not.toHaveBeenCalled()
    const brief = openBuild.mock.calls[0][1].prompt as string
    expect(brief).toContain('Fix: Retry drops the idempotency key')
    expect(brief).toContain('Location: src/checkout/pay.ts:142')
    expect(brief).toContain('Reuse the original key on retry.')
    expect(host.start).not.toHaveBeenCalled()
  })

  it('names a restored run after its request', () => {
    const host = { ...controller(), view: workflowView() }
    render(<LocalAnalysisWorkflowConversation tab={running} controller={host} />)
    expect(title).toHaveBeenCalledWith('tab-1', 'Check the selected scope')
  })

  it('says why a location an agent reported did not open', async () => {
    openLocation.mockResolvedValue('outside')
    const discoverTab = {
      ...running,
      localWorkflow: { ...running.localWorkflow!, preset: 'discover' as const }
    }
    const host = { ...controller(), view: discoverRunView() }
    render(<LocalAnalysisWorkflowConversation tab={discoverTab} controller={host} />)
    const report = screen.getByRole('region', { name: 'Report' })
    fireEvent.click(within(report).getByRole('button', { name: 'src/checkout/pay.ts:142' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('src/checkout/pay.ts:142: outside'))
    expect(openLocation).toHaveBeenCalledWith('tab-1', 'src/checkout/pay.ts:142')
  })

  it('keeps the prompt editable without manufacturing workflow availability', () => {
    render(<LocalAnalysisWorkflowConversation tab={tab} />)
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Workflows are not available on this host.')
    fireEvent.change(screen.getByLabelText('What should the workflow work on?'), {
      target: { value: 'Retain this draft' }
    })
    expect(save).toHaveBeenCalledWith(
      'workspace-1',
      'tab-1',
      expect.objectContaining({ prompt: 'Retain this draft' })
    )
  })
})
