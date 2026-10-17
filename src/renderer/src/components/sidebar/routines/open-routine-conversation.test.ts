import { beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'
const mocks = vi.hoisted(() => ({
  runs: vi.fn(),
  sessions: [] as unknown[],
  activate: vi.fn(),
  launch: vi.fn(),
  workspace: vi.fn(),
  mode: vi.fn(),
  bind: vi.fn(),
  legacy: {} as Record<string, unknown>,
  owners: [] as unknown[],
  state: {} as Record<string, unknown>
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/sidebar-sessions', () => ({ buildSidebarSessions: () => mocks.sessions }))
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: mocks.activate }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: mocks.workspace }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/components/automations/automation-host-client', () => ({
  getAutomationHostTargetKey: (target: { kind: string; environmentId?: string }) =>
    `${target.kind}:${target.environmentId ?? ''}`,
  listAutomationRunsForTarget: mocks.runs
}))
vi.mock('./routine-conversation-state', () => ({
  useRoutineConversations: { getState: () => ({ byRoutine: mocks.legacy }) }
}))
vi.mock('./routine-conversation-binding', () => ({ bindRoutineConversation: mocks.bind }))
vi.mock('./routine-session-catalog', () => ({
  routineConversationKey: () => JSON.stringify(['local:', 'routine']),
  useRoutineSessionCatalog: { getState: () => ({ owners: mocks.owners }) }
}))
import { describeLastRecordedResult, openRoutineConversation } from './open-routine-conversation'
const automation = {
  id: 'routine',
  name: 'Advertising',
  prompt: 'Review ads',
  agentId: 'claude',
  executionTargetType: 'local',
  projectId: 'repo',
  workspaceId: 'folder:work',
  workspaceMode: 'existing'
} as Automation
const run = {
  createdAt: 10,
  workspaceId: 'folder:work',
  terminalPaneKey: 'pane',
  status: 'completed'
}
const session = { hostId: 'local', worktreeId: 'folder:work', tabId: 'tab', paneKey: 'pane' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.owners = []
  mocks.legacy = {}
  mocks.state = {
    settings: { experimentalNativeChat: true },
    repos: [],
    setTabViewMode: mocks.mode
  }
  mocks.sessions = [session]
  mocks.runs.mockResolvedValue([run])
  mocks.activate.mockResolvedValue({ handled: 'opened' })
  mocks.workspace.mockReturnValue({ primaryTabId: null })
  mocks.launch.mockReturnValue({ tabId: 'new' })
})
it('opens the run without overriding its stored view mode', async () => {
  await openRoutineConversation(automation, { kind: 'local' })
  expect(mocks.activate).toHaveBeenCalledWith(session)
  expect(mocks.mode).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('does not open a matching pane on a different host', async () => {
  mocks.sessions = [{ ...session, hostId: 'runtime:other' }]
  mocks.runs.mockResolvedValue([{ ...run, status: 'dispatched' }])
  await expect(openRoutineConversation(automation, { kind: 'local' })).rejects.toThrow(
    'run in progress'
  )
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('keeps a failed history read from starting a duplicate conversation', async () => {
  mocks.runs.mockRejectedValue(new Error('host offline'))
  await expect(openRoutineConversation(automation, { kind: 'local' })).rejects.toThrow(
    'host offline'
  )
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('opens a new conversation with an editable routine brief when it has never run', async () => {
  mocks.runs.mockResolvedValue([])
  await openRoutineConversation(automation, { kind: 'local' })
  expect(mocks.workspace).toHaveBeenCalledWith('folder:work', {
    executionHostId: 'local',
    providesInitialSurface: true
  })
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      worktreeId: 'folder:work',
      promptDelivery: 'draft',
      viewModePreference: 'chat',
      prompt: expect.stringContaining('Review ads')
    })
  )
})
it('does not replace an unavailable run conversation with a fresh one', async () => {
  mocks.activate.mockResolvedValue(false)
  await expect(openRoutineConversation(automation, { kind: 'local' })).rejects.toThrow(
    'unavailable'
  )
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('ignores a history response after navigation changes', async () => {
  await openRoutineConversation(automation, { kind: 'local' }, () => false)
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('does not steal focus when the user navigates while history loads', async () => {
  mocks.runs.mockImplementation(async () => {
    mocks.state = { ...mocks.state, activeView: 'work' }
    return [run]
  })
  await openRoutineConversation(automation, { kind: 'local' })
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('binds a structured conversation after the host publishes it', async () => {
  mocks.runs.mockResolvedValue([])
  mocks.launch.mockImplementation(() => ({
    tabId: null,
    promptDeliveryResult: Promise.resolve().then(() => {
      mocks.sessions.push({ ...session, tabId: 'structured-new', paneKey: null })
      return { delivered: true }
    })
  }))
  await openRoutineConversation(automation, { kind: 'local' })
  expect(mocks.bind).toHaveBeenCalledWith(
    automation,
    { kind: 'local' },
    expect.objectContaining({ tabId: 'structured-new' }),
    'local'
  )
})
it('reports a rejected structured launch without claiming a conversation exists', async () => {
  mocks.runs.mockResolvedValue([])
  mocks.launch.mockReturnValue({
    tabId: null,
    promptDeliveryResult: Promise.resolve({ delivered: false })
  })
  await expect(openRoutineConversation(automation, { kind: 'local' })).rejects.toThrow(
    'could not open'
  )
  expect(mocks.bind).not.toHaveBeenCalled()
})

it('record binding wins over a live legacy binding', async () => {
  mocks.legacy[JSON.stringify(['local:', 'routine'])] = { tabId: 'legacy', paneKey: null }
  mocks.sessions = [session, { ...session, tabId: 'legacy' }]
  await openRoutineConversation(
    { ...automation, conversation: { tabId: 'tab', paneKey: 'pane' } },
    { kind: 'local' }
  )
  expect(mocks.activate).toHaveBeenCalledWith(session)
  expect(mocks.runs).not.toHaveBeenCalled()
})
it('stale record binding reuses the latest live run without launching', async () => {
  await openRoutineConversation(
    { ...automation, conversation: { tabId: 'dead', paneKey: null } },
    { kind: 'local' }
  )
  expect(mocks.activate).toHaveBeenCalledWith(session)
  expect(mocks.launch).not.toHaveBeenCalled()
})
it('coalesces concurrent opens for the same authority and routine', async () => {
  mocks.runs.mockResolvedValue([])
  await Promise.all([
    openRoutineConversation(automation, { kind: 'local' }),
    openRoutineConversation(automation, { kind: 'local' })
  ])
  expect(mocks.launch).toHaveBeenCalledTimes(1)
})

it('reuses an older live run when the newest run conversation was closed', async () => {
  mocks.runs.mockResolvedValue([{ ...run, createdAt: 20, terminalPaneKey: 'closed' }, run])
  await openRoutineConversation(automation, { kind: 'local' })
  expect(mocks.activate).toHaveBeenCalledWith(session)
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('seeds the conversation with the last result as prose, never screen text or a JSON fence', () => {
  const content = `Report body\n\n\`\`\`omni-actions\n[{"id":"a1","kind":"pause","label":"Pause WW Home WhoElse","nativeId":"1","reason":"Weaker intent"}]\n\`\`\``
  const prose = describeLastRecordedResult({
    ...run,
    title: 'Advertising run 7',
    outputSnapshot: { format: 'plain_text', content, capturedAt: 1, truncated: false }
  } as never)
  expect(prose).toBe(
    'Last recorded result:\nReport body\n\nProposed actions:\n- Pause WW Home WhoElse — Weaker intent\n\n'
  )
  const scraped = describeLastRecordedResult({
    ...run,
    title: 'Advertising run 8',
    outputSnapshot: {
      format: 'plain_text',
      content: '│ >_ OpenAI Codex\n  Spend is $421.89\n■ Conversation interrupted - R to Retry',
      capturedAt: 1,
      truncated: false
    }
  } as never)
  expect(scraped).toBe('Last recorded result:\nSpend is $421.89\n\n')
  expect(describeLastRecordedResult(null)).toBe('')
})
