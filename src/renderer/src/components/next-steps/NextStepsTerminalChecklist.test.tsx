// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import { NextStepsTerminalPill } from './NextStepsTerminalPill'
import { NextStepsTray } from './NextStepsTray'
import { refreshPendingNextSteps, usePendingNextSteps } from './next-steps-pending-store'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sets: [] as unknown[],
  current: null as unknown,
  revision: 1,
  agentState: undefined as string | undefined
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  RuntimeRpcCallError: class extends Error {
    code = 'error'
  }
}))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentStatusByPaneKey: mocks.agentState ? { 'tab-1:leaf-1': { state: mocks.agentState } } : {}
    })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const option = (id: string, title: string, over: Partial<NextStepSuggestion> = {}) => ({
  id,
  title,
  prompt: `Please go ahead with this option you offered: ${title}`,
  risk: 'safe' as const,
  kind: 'continue' as const,
  offered: true as const,
  optionGroup: 'menu-1',
  ...over
})
const menu = (id = 'parsed-1'): NextStepSuggestionSet => ({
  id,
  conversation,
  worktreeId: 'wt',
  turnKey: `tab-1:leaf-1@${id}`,
  origin: 'parsed',
  createdAt: 10,
  status: 'pending',
  suggestions: [
    option('s1', 'Write the onboarding email', { preselected: true }),
    option('s2', 'Draft the pricing page'),
    option('s3', 'Deploy the landing page', { preselected: true, risk: 'risky' })
  ]
})
const failedAi: NextStepSuggestionSet = {
  id: 'ai-1',
  conversation,
  worktreeId: 'wt',
  turnKey: 'tab-1:leaf-1@7',
  origin: 'ai',
  createdAt: 10,
  status: 'failed',
  suggestions: [],
  error: 'claude -p exited with code 1: invalid permission rule'
}

function host(target: unknown, method: string, params: Record<string, unknown>) {
  void target
  if (method === NEXT_STEPS_RPC.list) {
    return Promise.resolve({
      sets: mocks.sets,
      skips: [],
      revision: mocks.revision,
      keepGoing: [],
      keepGoingRevision: 1
    })
  }
  if (method === NEXT_STEPS_RPC.current) {
    return Promise.resolve(mocks.current)
  }
  if (method === NEXT_STEPS_RPC.keepGoing) {
    return Promise.resolve({
      state: { conversation, enabled: false, maxRounds: 3, roundsUsed: 0, startedAt: 1 }
    })
  }
  if (method === NEXT_STEPS_RPC.decide) {
    const decision = params.decision as { action: string; suggestionIds?: string[] }
    const set = mocks.sets[0] as NextStepSuggestionSet
    return Promise.resolve({
      set: { ...set, status: decision.action === 'dismiss' ? 'dismissed' : 'accepted' },
      queued: decision.suggestionIds ?? [],
      notQueued: []
    })
  }
  if (method === NEXT_STEPS_RPC.generate) {
    return Promise.resolve({ set: { ...failedAi, id: 'ai-2', status: 'generating' } })
  }
  return Promise.reject(new Error(`unexpected ${method}`))
}
const calls = (method: string) =>
  mocks.rpc.mock.calls.filter(([, name]) => name === method).map(([, , params]) => params)
const renderPill = () =>
  render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)

beforeEach(() => {
  usePendingNextSteps.setState({
    counts: new Map(),
    keepGoing: new Map(),
    keepGoingStopsSeen: new Map(),
    keepGoingRevision: null,
    sets: undefined,
    revision: null,
    unknown: false
  })
  const set = menu()
  mocks.sets = [set]
  mocks.current = {
    turnKey: set.turnKey,
    parsed: set,
    answered: false,
    turnObserved: true,
    revision: 2
  }
  mocks.revision = 1
  mocks.agentState = 'done'
  mocks.rpc.mockImplementation(host)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('a menu the session offered, in the terminal', () => {
  it('opens as a checklist, the named safe options ticked, never a risky one', async () => {
    renderPill()
    expect(await screen.findByText('✦ The session offered 3 options')).toBeTruthy()
    const box = (title: string) => screen.getByRole('checkbox', { name: title })
    await waitFor(() =>
      expect(box('Write the onboarding email').getAttribute('aria-checked')).toBe('true')
    )
    expect(box('Draft the pricing page').getAttribute('aria-checked')).toBe('false')
    expect(box('Deploy the landing page').getAttribute('aria-checked')).toBe('false')
    // One checklist, not one button per option.
    expect(screen.queryByRole('button', { name: /^Yes: / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Build selected (1)' })).toBeTruthy()
  })

  it('builds the ticked options with one decide, in the menu’s order', async () => {
    renderPill()
    await screen.findByRole('button', { name: 'Build selected (1)' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Deploy the landing page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Build selected (2)' }))
    await waitFor(() =>
      expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
        { setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s1', 's3'] } }
      ])
    )
  })

  it('cannot build nothing, and "No" sends nothing', async () => {
    renderPill()
    await screen.findByRole('button', { name: 'Build selected (1)' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write the onboarding email' }))
    const build = screen.getByRole('button', { name: 'Build selected (0)' }) as HTMLButtonElement
    expect(build.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'No, send nothing' }))
    await waitFor(() =>
      expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
        { setId: 'parsed-1', decision: { action: 'dismiss' } }
      ])
    )
  })

  it('collapses to the pill and opens again from it', async () => {
    renderPill()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse to the pill' }))
    expect(screen.queryByText('✦ The session offered 3 options')).toBeNull()
    const pill = screen.getByRole('button', { name: 'Show the options' })
    expect(pill.textContent).toContain('✦ 3 next steps')
    fireEvent.click(pill)
    expect(await screen.findByText('✦ The session offered 3 options')).toBeTruthy()
  })

  it('opens again for a new menu after the last one was collapsed', async () => {
    renderPill()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse to the pill' }))
    expect(screen.getByRole('button', { name: 'Show the options' })).toBeTruthy()
    const next = menu('parsed-2')
    mocks.sets = [next]
    mocks.revision += 1
    mocks.current = {
      turnKey: next.turnKey,
      parsed: next,
      answered: false,
      turnObserved: true,
      revision: 3
    }
    refreshPendingNextSteps()
    expect(await screen.findByText('✦ The session offered 3 options')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show the options' })).toBeNull()
  })

  it('stays hidden while an agent question owns the corner', async () => {
    render(
      <NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" suppressed />
    )
    await waitFor(() => expect(usePendingNextSteps.getState().revision).not.toBeNull())
    expect(screen.queryByText('✦ The session offered 3 options')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('a menu the session offered, in the chat tray', () => {
  const reply = {
    id: 'reply',
    role: 'assistant' as const,
    timestamp: 1,
    source: 'transcript' as const,
    blocks: [{ type: 'text' as const, text: 'Which of these should I do?' }]
  }
  const renderTray = () =>
    render(
      <NextStepsTray
        messages={[reply]}
        paneKey="tab-1:leaf-1"
        tabId="tab-1"
        conversation={conversation}
        disabled={false}
      />
    )

  it('is the checklist with the named options ticked and "Build selected", not one button each', async () => {
    renderTray()
    await screen.findByRole('button', { name: 'Build selected (1)' })
    expect(
      screen
        .getByRole('checkbox', { name: 'Write the onboarding email' })
        .getAttribute('aria-checked')
    ).toBe('true')
    expect(screen.queryByRole('button', { name: /^Yes: / })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Run selected/ })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Draft the pricing page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Build selected (2)' }))
    await waitFor(() =>
      expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
        { setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s1', 's2'] } }
      ])
    )
  })

  it('keeps one button per option for an offer that is not one menu', async () => {
    const set = menu()
    const loose: NextStepSuggestionSet = {
      ...set,
      suggestions: set.suggestions.slice(0, 2).map(({ optionGroup: _group, ...step }) => step)
    }
    mocks.current = {
      turnKey: set.turnKey,
      parsed: loose,
      answered: false,
      turnObserved: true,
      revision: 2
    }
    renderTray()
    expect(await screen.findByRole('button', { name: 'Yes: Draft the pricing page' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Build selected/ })).toBeNull()
  })
})

describe('a turn whose suggestions failed, in the terminal', () => {
  beforeEach(() => {
    mocks.sets = []
    mocks.current = {
      turnKey: failedAi.turnKey,
      ai: failedAi,
      answered: false,
      turnObserved: true,
      revision: 4
    }
  })

  it('says so quietly, with the reason on hover, and Retry is the explicit "Suggest again"', async () => {
    renderPill()
    const retry = await screen.findByRole('button', {
      name: `Retry suggesting next steps: ${failedAi.error}`
    })
    expect(retry.textContent).toBe('Couldn’t suggest next steps · Retry')
    expect(retry.getAttribute('title')).toBe(failedAi.error)
    // Nothing retries by itself.
    expect(calls(NEXT_STEPS_RPC.generate)).toEqual([])
    fireEvent.click(retry)
    await waitFor(() =>
      expect(calls(NEXT_STEPS_RPC.generate)).toEqual([{ conversation, force: true }])
    )
  })

  it('shortens a long reason in the tooltip', async () => {
    const long = 'x'.repeat(400)
    mocks.current = {
      turnKey: failedAi.turnKey,
      ai: { ...failedAi, error: long },
      answered: false,
      turnObserved: true,
      revision: 5
    }
    renderPill()
    const retry = await screen.findByRole('button', { name: /^Retry suggesting next steps: / })
    expect(retry.getAttribute('title')!.length).toBe(160)
    expect(retry.getAttribute('title')!.endsWith('…')).toBe(true)
  })

  it('asks nothing while the agent is still working', async () => {
    mocks.agentState = 'working'
    renderPill()
    await waitFor(() => expect(usePendingNextSteps.getState().revision).not.toBeNull())
    expect(calls(NEXT_STEPS_RPC.current)).toEqual([])
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull()
  })
})
