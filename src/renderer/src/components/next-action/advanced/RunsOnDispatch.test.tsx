// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { RunsOnDispatch } from './RunsOnDispatch'

/**
 * Why this test exists: `RunsOnDispatch` is now the ONLY dispatch door, single or bulk, so every
 * capability the deleted `AddNextPanels.fleet.test.tsx` pinned on row 🚀 has to be pinned here —
 * prepare+dispatch vs the ordinary session chain, the named machine, the silent card, the
 * continuing agent, the loading and error waits, the filing refusal that stays refused, and the
 * fan-out consent gate on both its sides. The real `useAddNextSend`/`dispatchToFleet` run; only
 * their ports are mocked.
 */
const READY = { phase: 'ready', value: [{ id: 'claude', label: 'Claude' }] }
const ports = vi.hoisted(() => ({
  onPrepare: vi.fn(),
  onDispatch: vi.fn(),
  onMachineChange: vi.fn(),
  sendNextStep: vi.fn(),
  createCard: vi.fn(),
  batchSubmit: vi.fn(),
  update: vi.fn(),
  rpc: vi.fn(),
  linked: null as { id: string; title: string } | null,
  fleetAgents: null as unknown,
  localAgents: null as unknown
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() }
}))
vi.mock('../use-up-next', () => ({ useUpNext: ports.update }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: ports.rpc }))
vi.mock('@/store', () => ({ useAppStore: (select: (value: unknown) => unknown) => select({}) }))
vi.mock('@/components/next-step/next-step-placement', () => ({
  findNextStepWorkspaceId: () => 'wt-local'
}))
vi.mock('@/components/next-step/next-step-send', () => ({
  createNextStepSendMemory: () => ({ operationIds: new Map(), sent: new Set() }),
  sendNextStep: ports.sendNextStep
}))
vi.mock('@/components/next-step/next-step-task-create', () => ({
  createNextStepCard: ports.createCard
}))
vi.mock('@/components/next-step/use-next-step-task', () => ({
  useNextStepTask: () => ({ linked: ports.linked })
}))
vi.mock('@/components/next-step/use-next-step-recipients', () => ({
  useNextStepRecipients: () => ({ agents: ports.localAgents })
}))
vi.mock('@/components/next-step/use-fleet-dispatch', () => ({
  useFleetDispatch: () => ({
    inventory: null,
    onMachineChange: ports.onMachineChange,
    onPrepare: ports.onPrepare,
    onDispatch: ports.onDispatch,
    recipients: { agents: ports.fleetAgents }
  })
}))
// Why: the real MenuTargets needs the whole inventory; the door under test is what each of its
// two answers does, so the stub offers exactly those — the hub's choice, a named machine, here.
vi.mock('@/components/next-step/add-next/MenuTargets', () => ({
  MenuTargets: ({
    onFleet,
    onHost
  }: {
    onFleet: (target: { machineId: string | null }) => void
    onHost: (placement: string) => void
  }) => (
    <>
      <button onClick={() => onFleet({ machineId: null })}>Fleet</button>
      <button onClick={() => onFleet({ machineId: 'mw0002' })}>mw0002</button>
      <button onClick={() => onHost('local')}>This Mac</button>
    </>
  )
}))

const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local' as const,
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal' as const,
  label: 'Improve the previous result',
  workspaceLabel: 'omni-ide',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
} as unknown as SidebarSession

const endSession = (): HTMLButtonElement =>
  screen.getByText('✓ Just run it · end session') as HTMLButtonElement
const backToMe = (): HTMLButtonElement =>
  screen.getByText('↩ Just run it · back to me') as HTMLButtonElement

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ports.linked = { id: 'task-1', title: 'Existing card' }
  ports.fleetAgents = READY
  ports.localAgents = READY
  ports.onPrepare.mockResolvedValue({ preview: {}, machineLabel: 'mw0002', contextSummary: '' })
  ports.onDispatch.mockResolvedValue(undefined)
  ports.sendNextStep.mockResolvedValue({ ok: true, message: 'Sent.' })
  ports.batchSubmit.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('the one dispatch door behind Runs on', () => {
  it('sends a fleet choice through prepare and dispatch with the card already resolved', async () => {
    const onSent = vi.fn()
    render(<RunsOnDispatch session={session} onSent={onSent} />)
    fireEvent.click(screen.getByText('Fleet'))
    await press(endSession())
    expect(ports.sendNextStep).not.toHaveBeenCalled()
    expect(ports.onPrepare).toHaveBeenCalledTimes(1)
    const [draft, machineId, fanout] = ports.onPrepare.mock.calls[0]!
    expect(draft.handoff.task).toEqual({ id: 'task-1', title: 'Existing card' })
    expect(draft.end).toBe('done')
    expect(machineId).toBeUndefined()
    expect(fanout).toBe(false)
    expect(ports.onDispatch).toHaveBeenCalledTimes(1)
    expect(onSent).toHaveBeenCalledTimes(1)
    // Why: location never edits the chain; it uses the existing dispatch doors only.
    expect(ports.update).not.toHaveBeenCalled()
    expect(ports.rpc).not.toHaveBeenCalled()
  })

  it('names the machine a person picked instead of leaving it to the hub', async () => {
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('mw0002'))
    expect(ports.onMachineChange).toHaveBeenCalledWith('mw0002')
    await press(endSession())
    expect(ports.onPrepare.mock.calls[0]![1]).toBe('mw0002')
  })

  // Why: the card is the fleet's only handle on the job; nobody is asked for one.
  it('creates the card silently when the conversation has none', async () => {
    ports.linked = null
    ports.createCard.mockResolvedValue({ task: { id: 'task-new', title: 'Improve' } })
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    await press(endSession())
    expect(ports.createCard).toHaveBeenCalledWith(session, 'Improve the previous result')
    expect(ports.onPrepare.mock.calls[0]![0].handoff.task).toEqual({
      id: 'task-new',
      title: 'Improve'
    })
  })

  it('keeps This Mac on the ordinary session chain', async () => {
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('This Mac'))
    await press(endSession())
    expect(ports.onPrepare).not.toHaveBeenCalled()
    expect(ports.sendNextStep).toHaveBeenCalledTimes(1)
    const draft = ports.sendNextStep.mock.calls[0]![1]
    expect(draft.placement).toBe('local')
    expect(draft.destinationWorktreeId).toBe('wt-local')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  // Why: 🚀 is meant to be one click — "continue this work there", with this session's own agent.
  it('dispatches the continuing agent, back to me, when nothing else was chosen', async () => {
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    await press(backToMe())
    const [draft] = ports.onPrepare.mock.calls[0]!
    expect(draft.recipients).toHaveLength(1)
    expect(draft.recipients[0].agent).toBe('claude')
    expect(draft.end).toBe('me')
  })

  it('falls back to the first agent the fleet can run', async () => {
    ports.fleetAgents = { phase: 'ready', value: [{ id: 'codex', label: 'Codex' }] }
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    await press(endSession())
    expect(ports.onPrepare.mock.calls[0]![0].recipients[0].agent).toBe('codex')
  })

  it('waits for the fleet before offering to run anything', async () => {
    ports.fleetAgents = { phase: 'loading' }
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    expect(screen.getByRole('status').textContent).toContain('Checking the fleet')
    expect(screen.queryByText('Choose an agent to continue this session.')).toBeNull()
    expect(endSession().disabled).toBe(true)
    expect(backToMe().disabled).toBe(true)
    await press(endSession())
    expect(ports.onPrepare).not.toHaveBeenCalled()
  })

  it('says why nobody can run it when the fleet has no usable agent', async () => {
    ports.fleetAgents = { phase: 'error', message: 'Fleet agent sign-in could not be verified.' }
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    expect(screen.getByRole('alert').textContent).toContain('sign-in could not be verified')
    expect(endSession().disabled).toBe(true)
    await press(endSession())
    expect(ports.onPrepare).not.toHaveBeenCalled()
  })

  // Why: an unfiled card is one the hub refuses to run, so none is created and the person is
  // sent to the page where the filing is fixed.
  it('creates nothing and points at OmniOS when the work cannot be filed', async () => {
    ports.linked = null
    ports.createCard.mockResolvedValue({
      refusal: "Complete the task's company, goal and department before dispatching.",
      actionUrl: 'https://console.example.com/work'
    })
    const onSent = vi.fn()
    render(<RunsOnDispatch session={session} onSent={onSent} />)
    fireEvent.click(screen.getByText('Fleet'))
    await press(endSession())
    expect(ports.onPrepare).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('company, goal and department')
    const link = screen.getByRole('link', { name: 'Open in OmniOS' }) as HTMLAnchorElement
    expect(link.href).toBe('https://console.example.com/work')
    expect(onSent).not.toHaveBeenCalled()
    // Why: pressing again before the estate is fixed would fail in exactly the same way.
    expect(endSession().disabled).toBe(true)
    await press(endSession())
    expect(ports.createCard).toHaveBeenCalledTimes(1)
    // Why: a different place deserves a fresh answer, so the refusal lets go there.
    fireEvent.click(screen.getByText('This Mac'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(endSession().disabled).toBe(false)
  })

  it('shows a prepare failure in the popover instead of closing it', async () => {
    ports.onPrepare.mockRejectedValue(new Error('This repository is not available to the fleet.'))
    const onSent = vi.fn()
    render(<RunsOnDispatch session={session} onSent={onSent} />)
    fireEvent.click(screen.getByText('Fleet'))
    await press(endSession())
    expect(onSent).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('not available to the fleet')
  })
})

describe('the fan-out consent gate', () => {
  it('requires the operator’s own tick before running several agents at once', async () => {
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    fireEvent.change(screen.getByLabelText('Agents for this dispatch'), { target: { value: '3' } })
    const consent = screen.getByRole('checkbox') as HTMLInputElement
    expect(consent.checked).toBe(false)
    expect(endSession().disabled).toBe(true)
    await press(endSession())
    expect(ports.onPrepare).not.toHaveBeenCalled()
    fireEvent.click(consent)
    await press(endSession())
    await waitFor(() => expect(ports.onPrepare).toHaveBeenCalledOnce())
    const [draft, , acknowledged] = ports.onPrepare.mock.calls[0]!
    expect(draft.recipients).toHaveLength(3)
    expect(acknowledged).toBe(true)
    // Why: consent is per dispatch; the next one asks again.
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('never acknowledges a fan-out for a single agent', async () => {
    render(<RunsOnDispatch session={session} onSent={vi.fn()} />)
    fireEvent.click(screen.getByText('Fleet'))
    expect(screen.queryByRole('checkbox')).toBeNull()
    await press(endSession())
    expect(ports.onPrepare.mock.calls[0]![2]).toBe(false)
  })

  it('treats a batch of conversations as a fan-out and hands it to the batch sender', async () => {
    render(
      <RunsOnDispatch
        session={session}
        onSent={vi.fn()}
        batch={{ count: 2, onSubmit: ports.batchSubmit }}
      />
    )
    fireEvent.click(screen.getByText('mw0002'))
    expect(screen.getByText(/Dispatches 2 selected conversations/)).toBeTruthy()
    const consent = screen.getByRole('checkbox') as HTMLInputElement
    expect(screen.getByText(/Dispatch 2 conversations at once/)).toBeTruthy()
    expect(endSession().disabled).toBe(true)
    await press(endSession())
    expect(ports.batchSubmit).not.toHaveBeenCalled()
    fireEvent.click(consent)
    await press(endSession())
    await waitFor(() => expect(ports.batchSubmit).toHaveBeenCalledOnce())
    expect(ports.batchSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ end: 'done', placement: null }),
      'mw0002',
      true
    )
    // Why: the batch sends each conversation itself; this body must not send the first one twice.
    expect(ports.onPrepare).not.toHaveBeenCalled()
    expect(ports.sendNextStep).not.toHaveBeenCalled()
  })

  it('offers no local placement for a batch, because the batch only runs on the fleet', () => {
    render(
      <RunsOnDispatch
        session={session}
        onSent={vi.fn()}
        batch={{ count: 2, onSubmit: ports.batchSubmit }}
      />
    )
    fireEvent.click(screen.getByText('This Mac'))
    expect(endSession().disabled).toBe(true)
  })
})
