// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddNextMenu } from './AddNextMenu'

const toasts = vi.hoisted(() => ({ message: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
const send = vi.hoisted(() =>
  vi.fn(async (_subject: unknown, _draft: unknown, _memory: unknown) => ({
    ok: true,
    message: 'Saved'
  }))
)
vi.mock('./next-step-send', () => ({ sendNextStep: send, createNextStepSendMemory: () => ({}) }))
vi.mock('./use-next-step-recipients', () => ({
  useNextStepRecipients: () => ({
    agents: {
      phase: 'ready',
      value: [
        { id: 'claude', label: 'Claude' },
        { id: 'codex', label: 'Codex' },
        { id: 'gemini', label: 'Gemini' }
      ]
    },
    people: { phase: 'ready', value: [{ id: 'sal', name: 'Sal' }] },
    reload: vi.fn()
  }),
  // Why: 🚀 now reads the fleet as well, and its hook asks the same module for the roster.
  useNextStepPeople: () => ({ people: { phase: 'ready', value: [] }, reload: vi.fn() })
}))
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null
}))
vi.mock('@/components/agent/AgentAccountSelect', () => ({ AgentAccountSelect: () => null }))
const appState = {
  settings: {},
  runtimeEnvironments: [],
  sshTargets: [],
  repos: [],
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  folderWorkspaces: [],
  getKnownWorktreeById: () => undefined
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: unknown) => unknown) => select(appState), {
    getState: () => appState
  })
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
const subject = {
  kind: 'session' as const,
  session: {
    rowKey: 'row',
    sessionKey: 'session',
    worktreeId: 'wt',
    hostId: 'local' as const,
    tabId: 'tab',
    paneKey: 'pane',
    kind: 'terminal' as const,
    label: 'Build',
    workspaceLabel: 'Repo',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}
const trigger = () => screen.getByRole('button', { name: 'Add Next' })
const agent = (name: string) => screen.getByRole('menuitem', { name })
// Explicit recipient entry keeps the legacy level/recipient contracts under WHERE.
function openAgent() {
  fireEvent.click(trigger())
  fireEvent.pointerEnter(agent('🤖 Agent'))
}
beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  send.mockClear()
  toasts.message.mockClear()
  toasts.error.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AddNextMenu', () => {
  it('offers no later steps and no ending on a card', () => {
    render(
      <AddNextMenu subject={{ kind: 'card', item: { task_id: 'btk', title: 'Card' } } as never} />
    )
    fireEvent.click(trigger())
    fireEvent.pointerEnter(agent('🤖 Agent'))
    fireEvent.click(agent('Claude'))
    expect(screen.queryByRole('button', { name: '＋ 🤖 Agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End session' })).toBeNull()
    expect(
      screen.queryByRole('menuitem', { name: 'End session upon successful completion' })
    ).toBeNull()
  })
  it('stays silent when the pointer passes over a control that cannot open', () => {
    render(<AddNextMenu subject={subject} disabledReason="No pane to continue" />)
    fireEvent.pointerEnter(trigger())
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(toasts.message).not.toHaveBeenCalled()
    fireEvent.click(trigger())
    expect(toasts.message).toHaveBeenCalledWith('No pane to continue')
  })
  it('opens after intent and closes after pointer grace', () => {
    render(<AddNextMenu subject={subject} />)
    fireEvent.pointerEnter(trigger())
    act(() => vi.advanceTimersByTime(119))
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerLeave(trigger())
    act(() => vi.advanceTimersByTime(249))
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('pins on click and Escape restores trigger focus', () => {
    render(<AddNextMenu subject={subject} />)
    fireEvent.click(trigger())
    fireEvent.pointerLeave(trigger())
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
  it('previews on hover, commits one handoff, and replaces it on selection', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.pointerEnter(agent('Claude'))
    expect(screen.getByText('What should it do?')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(agent('Claude'))
    fireEvent.click(agent('Codex'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      mode: 'handoff',
      recipients: [{ agent: 'codex' }]
    })
  })
  it('allows several reviewers and defaults their shared action to review', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }))
    for (const name of ['Claude', 'Codex', 'Gemini']) {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name }))
    }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    const draft = send.mock.calls[0]?.[1] as { recipients: { presetId: string }[] }
    expect(draft.recipients).toHaveLength(3)
    expect(draft.recipients.every((entry) => entry.presetId === 'review')).toBe(true)
  })
  it('sends what was clicked, never what the pointer passed over', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(agent('Claude'))
    fireEvent.pointerEnter(agent('Codex'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(send.mock.calls[0]?.[1]).toMatchObject({ recipients: [{ agent: 'claude' }] })
  })
  it('keeps the chosen recipient at level 1 when Then what follows a hover', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(agent('Claude'))
    fireEvent.pointerEnter(agent('Codex'))
    fireEvent.click(screen.getByRole('button', { name: '＋ 🤖 Agent' }))
    fireEvent.click(agent('Gemini'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      recipients: [{ agent: 'claude' }],
      after: [{ level: 2, actor: { agent: 'gemini' } }]
    })
  })
  it('asks a person at a later level for a review instead of handing the work over', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(agent('Claude'))
    fireEvent.click(screen.getByRole('button', { name: '＋ 👤 Person' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sal' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      after: [{ kind: 'person', id: 'sal', action: 'review', level: 2 }]
    })
  })
  it('drops the review action when the level goes back to a handoff', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Handoff' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      mode: 'handoff',
      recipients: [{ agent: 'claude', presetId: 'improve' }]
    })
  })
  it('does not expose the retired dispatch target panels', () => {
    render(<AddNextMenu subject={subject} />)
    fireEvent.click(trigger())
    expect(screen.queryByRole('menuitem', { name: /This (Mac|computer)/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Just run it/ })).toBeNull()
  })
  it('names who and what in the plan crumbs', () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(agent('Claude'))
    fireEvent.click(screen.getByRole('button', { name: '＋ 👤 Person' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask for review' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sal' }))
    const crumbs = screen.getByRole('navigation', { name: 'Plan levels' }).textContent ?? ''
    expect(crumbs).toContain('🤖 Claude')
    expect(crumbs).toContain('👤 Sal · review')
    expect(crumbs).not.toContain('L1')
  })
  it('adds up to five levels and toggles the ending', async () => {
    render(<AddNextMenu initialKind="agent" subject={subject} />)
    openAgent()
    fireEvent.click(agent('Claude'))
    for (let index = 1; index < 5; index++) {
      fireEvent.click(screen.getByRole('button', { name: '＋ 🤖 Agent' }))
      fireEvent.click(agent('Codex'))
    }
    expect(
      (screen.getByRole('button', { name: '＋ 🤖 Agent' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    expect(screen.getByRole('button', { name: 'End session' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      end: 'done',
      after: [{ level: 2 }, { level: 3 }, { level: 4 }, { level: 5 }]
    })
  })
})
