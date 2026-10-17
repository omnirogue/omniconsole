// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextStepSuggestionSet } from '../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type * as translationModule from '@/i18n/i18n'
import { isReplyDecisionOwnerCurrent, readRemoteReplyDecisions } from './remote-reply-decisions'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { withReplyDecisionAttention } from '../attention/reply-decision-attention'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '../attention/agent-pane-snapshot'
import { attentionFixturePane } from '../attention/attention-test-fixtures'
import { selectAgentPaneSnapshotInputs } from '../attention/use-agent-pane-snapshot'
import { createNextStepReplyPtyProof } from '../../../../shared/next-step-reply-proof'
import { NextStepsSessionBadge } from './NextStepsSessionBadge'
import { NextStepsTerminalPill } from './NextStepsTerminalPill'
import {
  refreshPendingNextSteps,
  useCurrentReplyDecisions,
  usePendingNextSteps
} from './next-steps-pending-store'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sets: [] as unknown[],
  keepGoing: [] as unknown[],
  replyDecisions: undefined as unknown[] | undefined,
  state: { agentStatusByPaneKey: {} } as Record<string, unknown>
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
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof translationModule>()),
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const pending: NextStepSuggestionSet = {
  id: 'ai-1',
  conversation,
  worktreeId: 'wt',
  turnKey: 'tab-1:leaf-1@5',
  origin: 'ai',
  createdAt: 10,
  status: 'pending',
  suggestions: ['Run the tests', 'Open a draft PR', 'Update the docs'].map((title, index) => ({
    id: `a${index + 1}`,
    title,
    prompt: `Please ${title.toLowerCase()}.`,
    risk: 'safe' as const,
    kind: 'continue' as const
  }))
}
const session = {
  kind: 'terminal',
  worktreeId: 'wt',
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  label: 'Parser work'
} as unknown as SidebarSession

beforeEach(() => {
  usePendingNextSteps.setState({
    counts: new Map(),
    keepGoing: new Map(),
    keepGoingStopsSeen: new Map(),
    keepGoingRevision: null,
    revision: null,
    unknown: false,
    replyDecisions: undefined,
    remoteReplyDecisions: undefined
  })
  mocks.sets = [pending]
  mocks.keepGoing = []
  mocks.replyDecisions = undefined
  mocks.state = { agentStatusByPaneKey: {} }
  replaceRuntimeEnvironmentRevisions([])
  mocks.rpc.mockImplementation((_target: unknown, method: string) =>
    method === NEXT_STEPS_RPC.list
      ? Promise.resolve({
          sets: mocks.sets,
          skips: [],
          revision: mocks.sets.length + mocks.keepGoing.length + 1,
          keepGoing: mocks.keepGoing,
          keepGoingRevision: mocks.keepGoing.length + 1,
          replyDecisions: mocks.replyDecisions
        })
      : method === NEXT_STEPS_RPC.current
        ? Promise.resolve({
            turnKey: pending.turnKey,
            ai: pending,
            answered: false,
            turnObserved: true,
            revision: 2
          })
        : Promise.reject(new Error(`unexpected ${method}`))
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('refreshes decision-only changes on the shared poll and clears them for old or failed hosts', async () => {
  const entry = {
    ...conversation,
    tabId: 'tab-1',
    state: 'done',
    stateStartedAt: 500,
    lastAssistantMessage: 'Should I build it?',
    providerSession: { key: 'session_id', id: 'provider' }
  }
  mocks.state = { agentStatusByPaneKey: { [conversation.paneKey]: entry } }
  const decision = {
    conversation,
    turnKey: pending.turnKey,
    completedAt: 10,
    question: 'Should I build it?',
    ptyProof: createNextStepReplyPtyProof(pending.turnKey, entry)!
  }
  function Decisions() {
    return (
      <div>
        {useCurrentReplyDecisions()
          .map((decision) => decision.question)
          .join(' ')}
      </div>
    )
  }
  render(<Decisions />)
  await waitFor(() => expect(usePendingNextSteps.getState().revision).not.toBeNull())
  mocks.replyDecisions = [decision]
  refreshPendingNextSteps()
  await screen.findByText('Should I build it?')
  mocks.replyDecisions = undefined
  refreshPendingNextSteps()
  await waitFor(() => expect(screen.queryByText('Should I build it?')).toBeNull())
  mocks.replyDecisions = [decision]
  refreshPendingNextSteps()
  await screen.findByText('Should I build it?')
  mocks.rpc.mockRejectedValueOnce(new Error('host unavailable'))
  refreshPendingNextSteps()
  await waitFor(() => expect(screen.queryByText('Should I build it?')).toBeNull())
  expect(usePendingNextSteps.getState().unknown).toBe(true)
})

it('projects only the paired owner’s exact current question and revokes replaced or missing evidence', async () => {
  const environment = { id: 'remote-owner', createdAt: 100, pairingRevision: 101 }
  replaceRuntimeEnvironmentRevisions([environment])
  const leafId = '11111111-1111-4111-8111-111111111111'
  const tabId = toWebTerminalSurfaceTabId('owner-tab')
  const paneKey = makePaneKey(tabId, leafId)
  const question = 'Should I check the picker before installing?'
  const entry = {
    paneKey,
    tabId,
    worktreeId: 'wt',
    state: 'done',
    stateStartedAt: 7000,
    updatedAt: 10,
    prompt: 'Client preview can differ from the owner prompt',
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'provider-session' },
    lastAssistantMessage: question
  }
  const tab = {
    id: tabId,
    entityId: tabId,
    worktreeId: 'wt',
    contentType: 'terminal',
    executionHostId: 'runtime:remote-owner'
  }
  const connected = { status: { runtimeId: 'owner-process' }, connectionGeneration: 3 }
  const initial = {
    settings: { activeRuntimeEnvironmentId: environment.id },
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([[environment.id, connected]]),
    unifiedTabsByWorktree: { wt: [tab] },
    terminalLayoutsByTabId: {
      [tabId]: {
        ptyIdsByLeafId: { [leafId]: toRemoteRuntimePtyId('terminal-owner', environment.id) }
      }
    },
    agentStatusByPaneKey: { [paneKey]: entry }
  }
  mocks.state = initial
  const response = {
    sets: [],
    skips: [],
    revision: 1,
    executionRuntimeId: 'owner-process',
    replyDecisions: [
      {
        conversation: { worktreeId: 'wt', paneKey: makePaneKey('owner-tab', leafId), kind: 'pty' },
        turnKey: 'owner-turn',
        completedAt: 10,
        question,
        ptyProof: createNextStepReplyPtyProof('owner-turn', entry)!
      }
    ]
  }
  mocks.rpc.mockResolvedValue(response)
  const projected = await readRemoteReplyDecisions()
  expect(projected).toHaveLength(1)
  expect(projected[0]!.conversation.paneKey).toBe(paneKey)
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: environment.id },
    NEXT_STEPS_RPC.list,
    { statuses: ['pending'] },
    { timeoutMs: 10_000, expectedEnvironmentPairingRevision: 101 }
  )
  const card = attentionFixturePane({ paneKey, tabId, worktreeId: 'wt', dotState: 'done' })
  const snapshot = { ...EMPTY_AGENT_PANE_SNAPSHOT, cardsByPaneKey: new Map([[paneKey, card]]) }
  expect(
    withReplyDecisionAttention(
      snapshot,
      projected,
      selectAgentPaneSnapshotInputs(initial as never)
    ).attentionByPaneKey.get(paneKey)?.askSummary
  ).toBe(question)
  for (const changed of [
    { runtimeStatusByEnvironmentId: new Map([[environment.id, { status: null }]]) },
    {
      runtimeStatusByEnvironmentId: new Map([
        [environment.id, { ...connected, connectionGeneration: 4 }]
      ])
    },
    {
      runtimeStatusByEnvironmentId: new Map([
        [environment.id, { status: { runtimeId: 'replacement' } }]
      ])
    },
    { runtimeEnvironments: [{ ...environment, pairingRevision: 102 }] },
    { agentStatusByPaneKey: { [paneKey]: { ...entry, state: 'working' } } },
    { agentStatusByPaneKey: { [paneKey]: { ...entry, stateStartedAt: 11 } } },
    { agentStatusByPaneKey: { [paneKey]: { ...entry, prompt: 'A new local user prompt' } } },
    {
      agentStatusByPaneKey: {
        [paneKey]: { ...entry, providerSession: { key: 'session_id', id: 'replacement' } }
      }
    },
    { unifiedTabsByWorktree: { wt: [{ ...tab, executionHostId: 'local' }] } }
  ]) {
    expect(isReplyDecisionOwnerCurrent(projected[0]!, { ...initial, ...changed } as never)).toBe(
      false
    )
  }
  for (const result of [
    { ...response, executionRuntimeId: undefined },
    { ...response, executionRuntimeId: 'replacement' },
    { ...response, replyDecisions: undefined },
    { ...response, replyDecisions: [{ ...response.replyDecisions[0], ptyProof: undefined }] },
    { ...response, replyDecisions: [{ ...response.replyDecisions[0], turnKey: 'different-turn' }] },
    {
      ...response,
      replyDecisions: [
        {
          ...response.replyDecisions[0],
          ptyProof: createNextStepReplyPtyProof('owner-turn', {
            ...entry,
            lastAssistantMessage: 'Should I deploy it?'
          })
        }
      ]
    }
  ]) {
    mocks.rpc.mockResolvedValueOnce(result)
    expect(await readRemoteReplyDecisions()).toEqual([])
  }
  let complete!: (value: typeof response) => void
  mocks.rpc.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    })
  )
  const pendingRead = readRemoteReplyDecisions()
  mocks.state = { ...initial, agentStatusByPaneKey: { [paneKey]: { ...entry, state: 'working' } } }
  complete(response)
  expect(await pendingRead).toEqual([])
  mocks.state = initial
  mocks.rpc.mockRejectedValueOnce(new Error('owner unreachable'))
  expect(await readRemoteReplyDecisions()).toEqual([])
})

it('shows a pill on a terminal pane with a pending set and opens the tray from it', async () => {
  render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)
  const pill = await screen.findByRole('button', { name: '✦ 3 next steps' })
  expect(mocks.rpc.mock.calls[0]![2]).toEqual({ statuses: ['pending'] })
  fireEvent.click(pill)
  expect(await screen.findByText('Open a draft PR')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Run all safe (3)' })).toBeTruthy()
})

it('shows no pill without a pending set', async () => {
  mocks.sets = []
  render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalled())
  expect(screen.queryByRole('button')).toBeNull()
})

it('badges a sidebar row with its pending count and opens the conversation', async () => {
  const onOpen = vi.fn()
  render(<NextStepsSessionBadge session={session} onOpen={onOpen} />)
  const badge = await screen.findByRole('button', {
    name: '3 suggested next steps in Parser work'
  })
  expect(badge.textContent).toBe('✦3')
  fireEvent.click(badge)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('shows no badge on a row whose conversation has none', async () => {
  render(
    <NextStepsSessionBadge
      session={{ ...session, paneKey: 'tab-2:leaf-1' } as SidebarSession}
      onOpen={vi.fn()}
    />
  )
  await waitFor(() => expect(usePendingNextSteps.getState().revision).not.toBeNull())
  expect(screen.queryByRole('button')).toBeNull()
})

it('shows no badge while the pending count is unknown, not a zero or a stale number', async () => {
  const onOpen = vi.fn()
  render(<NextStepsSessionBadge session={session} onOpen={onOpen} />)
  await screen.findByRole('button', { name: '3 suggested next steps in Parser work' })
  mocks.rpc.mockRejectedValue(new Error('host unavailable'))
  refreshPendingNextSteps()
  await waitFor(() => expect(usePendingNextSteps.getState().unknown).toBe(true))
  expect(screen.queryByRole('button')).toBeNull()
})

it('never lets an older answer overwrite a newer one', async () => {
  const answers: ((value: unknown) => void)[] = []
  mocks.rpc.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  await waitFor(() => expect(answers).toHaveLength(1))
  refreshPendingNextSteps()
  await waitFor(() => expect(answers).toHaveLength(2))
  answers[1]!({ sets: [pending], skips: [], revision: 5 })
  await screen.findByRole('button', { name: '3 suggested next steps in Parser work' })
  answers[0]!({ sets: [], skips: [], revision: 4 })
  await Promise.resolve()
  expect(usePendingNextSteps.getState().revision).toBe(5)
  expect(screen.getByRole('button', { name: '3 suggested next steps in Parser work' })).toBeTruthy()
})

it('skips an unchanged revision and stops polling once nothing is mounted', async () => {
  vi.useFakeTimers()
  const view = render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  await vi.advanceTimersByTimeAsync(10)
  const state = usePendingNextSteps.getState()
  mocks.sets = []
  // Same revision as before: the host says nothing changed, so the counts are not rebuilt.
  mocks.rpc.mockResolvedValue({
    sets: [],
    skips: [],
    revision: state.revision,
    keepGoingRevision: state.keepGoingRevision
  })
  await vi.advanceTimersByTimeAsync(2_100)
  expect(usePendingNextSteps.getState().counts).toBe(state.counts)
  const polled = mocks.rpc.mock.calls.length
  view.unmount()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(mocks.rpc.mock.calls.length).toBe(polled)
})

const running = { conversation, enabled: true, maxRounds: 3, roundsUsed: 1, startedAt: 1 }

it('keeps the pill up with a running mark while keep going drives the pane', async () => {
  mocks.sets = []
  mocks.keepGoing = [running]
  render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)
  const pill = await screen.findByRole('button', { name: 'Keep going' })
  expect(pill.getAttribute('data-next-steps-keep-going')).toBe('true')
})

it('marks the sidebar badge while keep going runs', async () => {
  mocks.sets = []
  mocks.keepGoing = [running]
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  const badge = await screen.findByRole('button', { name: 'Keep going is on in Parser work' })
  expect(badge.getAttribute('data-next-steps-keep-going')).toBe('true')
})

it('keeps the pending count in the badge label while keep going runs', async () => {
  mocks.keepGoing = [running]
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  expect(
    await screen.findByRole('button', {
      name: '3 suggested next steps in Parser work. Keep going is on in Parser work'
    })
  ).toBeTruthy()
})

it('keeps the last known keep-going state when a read fails', async () => {
  mocks.sets = []
  mocks.keepGoing = [running]
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  await screen.findByRole('button', { name: 'Keep going is on in Parser work' })
  mocks.rpc.mockRejectedValue(new Error('host unavailable'))
  refreshPendingNextSteps()
  await waitFor(() => expect(usePendingNextSteps.getState().unknown).toBe(true))
  expect(screen.getByRole('button', { name: 'Keep going is on in Parser work' })).toBeTruthy()
})

it('shows a stop that made no new set, by its own revision', async () => {
  mocks.sets = []
  mocks.rpc.mockImplementation(() =>
    Promise.resolve({
      sets: [],
      skips: [],
      revision: 5,
      keepGoing: mocks.keepGoing,
      keepGoingRevision: mocks.keepGoing.length ? 2 : 1
    })
  )
  mocks.keepGoing = [running]
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  await screen.findByRole('button', { name: 'Keep going is on in Parser work' })
  mocks.keepGoing = []
  refreshPendingNextSteps()
  await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
})

it('shows no running mark once keep going has stopped', async () => {
  mocks.sets = []
  mocks.keepGoing = [{ ...running, enabled: false, stopReason: 'cap-reached', stoppedAt: 2 }]
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  await waitFor(() => expect(usePendingNextSteps.getState().revision).not.toBeNull())
  expect(screen.queryByRole('button')).toBeNull()
})

it('always refreshes from a host that sends no keep-going revision', async () => {
  mocks.sets = []
  mocks.rpc.mockImplementation(() =>
    Promise.resolve({ sets: [], skips: [], revision: 5, keepGoing: mocks.keepGoing })
  )
  mocks.keepGoing = [running]
  render(<NextStepsSessionBadge session={session} onOpen={vi.fn()} />)
  await screen.findByRole('button', { name: 'Keep going is on in Parser work' })
  mocks.keepGoing = []
  refreshPendingNextSteps()
  await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
})

describe('the session asked: the pill is the answer', () => {
  const asked = (titles: string[]): NextStepSuggestionSet => ({
    ...pending,
    id: 'parsed-1',
    origin: 'parsed',
    suggestions: titles.map((title, index) => ({
      id: `s${index + 1}`,
      title,
      prompt: `Please go ahead with this next step you suggested: ${title}`,
      // The risk label never gates the person's own answer.
      risk: 'risky' as const,
      kind: 'fix' as const,
      offered: true as const
    }))
  })
  const answering = () => {
    const list = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation((target: unknown, method: string, params: unknown) =>
      method === NEXT_STEPS_RPC.decide
        ? Promise.resolve({ set: mocks.sets[0], queued: ['s1'], notQueued: [] })
        : method === NEXT_STEPS_RPC.keepGoing
          ? Promise.resolve({
              state: { conversation, enabled: false, maxRounds: 3, roundsUsed: 0, startedAt: 1 }
            })
          : list(target, method, params)
    )
  }
  const decided = () =>
    mocks.rpc.mock.calls
      .filter(([, method]) => method === NEXT_STEPS_RPC.decide)
      .map(([, , p]) => p)

  it('sends the session’s whole proposal with one click on "Yes", no popover first', async () => {
    const title = 'Make those two wording fixes, and save the rebuilt originals as backups'
    mocks.sets = [asked([title])]
    answering()
    render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)
    const yes = await screen.findByRole('button', { name: `Yes: ${title}` })
    expect(yes.textContent).toBe(`Yes · ${title}`)
    expect(screen.getAllByRole('button', { name: /^Yes: / })).toHaveLength(1)
    fireEvent.click(yes)
    await waitFor(() =>
      expect(decided()).toEqual([
        { setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s1'] } }
      ])
    )
    // Keep going is stopped on the host before the answer, as for any answer.
    const methods = mocks.rpc.mock.calls.map(([, method]) => method)
    expect(methods.indexOf(NEXT_STEPS_RPC.keepGoing)).toBeLessThan(
      methods.indexOf(NEXT_STEPS_RPC.decide)
    )
    expect(screen.queryByText('Suggested next steps')).toBeNull()
  })

  it('offers one button per option and "No" sends nothing', async () => {
    mocks.sets = [asked(['Add tests for the empty case', 'Open a PR'])]
    answering()
    render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Yes: Open a PR' }))
    await waitFor(() =>
      expect(decided()).toEqual([
        { setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s2'] } }
      ])
    )
    fireEvent.click(screen.getByRole('button', { name: 'No, send nothing' }))
    await waitFor(() => expect(decided()).toHaveLength(2))
    expect(decided()[1]).toEqual({ setId: 'parsed-1', decision: { action: 'dismiss' } })
  })

  it('keeps the plain pill for a reply that only listed next steps', async () => {
    const listed = asked(['Review the PR'])
    const { offered: _offered, ...step } = listed.suggestions[0]!
    mocks.sets = [{ ...listed, suggestions: [step] }]
    render(<NextStepsTerminalPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)
    expect(await screen.findByRole('button', { name: '✦ 1 next steps' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Yes: / })).toBeNull()
  })
})
