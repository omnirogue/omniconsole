import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDecision } from '../../../../shared/session-decisions'

const LEAF = '11111111-2222-4333-8444-555555555555'
const PANE = `tab-1:${LEAF}`
const NEW_LEAF = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const ASK = JSON.stringify({
  questions: [
    { question: 'Ship now?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }
  ]
})

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  launch: vi.fn(),
  enqueue: vi.fn(),
  call: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/sleeping-agent-session-launch', () => ({ launchSleepingAgentSession: mocks.launch }))
vi.mock('@/components/prompt-queue/use-prompt-queue', () => ({ enqueuePromptOnce: mocks.enqueue }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))

import { decisionDelivery, deliverDecisionAsMessage } from './session-decision-answer'

const decision: SessionDecision = {
  key: 'claude-1:toolu_1',
  paneKey: PANE,
  worktreeId: 'wt-1',
  agent: 'claude',
  askedAt: 1,
  toolUseId: 'toolu_1',
  toolName: 'AskUserQuestion',
  interactivePrompt: ASK,
  context: null,
  providerSession: { key: 'session_id', id: 'claude-1' },
  endedAt: 5,
  scores: null,
  updatedAt: 5,
  title: null,
  questions: [
    { question: 'Ship now?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }
  ],
  scoreUnavailable: null
}

function state(patch: Record<string, unknown> = {}): never {
  return {
    agentStatusByPaneKey: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    ...patch
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.enqueue.mockResolvedValue({ items: [] })
  mocks.call.mockResolvedValue({ removed: true })
})

describe('which way an answer reaches the session', () => {
  it('types it into the terminal while the agent still waits on that exact question', () => {
    const live = state({
      agentStatusByPaneKey: {
        [PANE]: { state: 'waiting', interactivePrompt: ASK, toolName: 'AskUserQuestion' }
      },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } }
    })
    expect(decisionDelivery(live, decision)).toEqual({
      kind: 'keys',
      tabId: 'tab-1',
      ptyId: 'pty-1'
    })
  })

  it('sends it as the next message when the conversation was resumed in another live pane', () => {
    const other = `tab-2:${NEW_LEAF}`
    const resumed = state({
      agentStatusByPaneKey: {
        [other]: {
          state: 'done',
          providerSession: { key: 'session_id', id: 'claude-1' },
          worktreeId: 'wt-1'
        }
      },
      terminalLayoutsByTabId: { 'tab-2': { ptyIdsByLeafId: { [NEW_LEAF]: 'pty-2' } } }
    })
    expect(decisionDelivery(resumed, decision)).toEqual({
      kind: 'message',
      worktreeId: 'wt-1',
      paneKey: other
    })
  })

  it('resumes the conversation when nothing live holds it, from its sleeping record or its own handle', () => {
    const sleeping = {
      paneKey: PANE,
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: decision.providerSession
    }
    expect(
      decisionDelivery(state({ sleepingAgentSessionsByPaneKey: { [PANE]: sleeping } }), decision)
    ).toEqual({
      kind: 'resume',
      record: sleeping
    })
    expect(decisionDelivery(state(), decision)).toMatchObject({
      kind: 'resume',
      record: {
        paneKey: PANE,
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: decision.providerSession
      }
    })
  })

  it('never starts a second process while the question’s terminal is still open', () => {
    const open = state({
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } }
    })
    expect(decisionDelivery(open, decision)).toEqual({ kind: 'unreachable' })
  })

  it('leaves the answer to the pane that asked after a restart: never queued or resumed', () => {
    // The restart left a live record on the pane and its status still reads as before the ask.
    const pane = {
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } },
      sleepingAgentSessionsByPaneKey: {
        [PANE]: {
          paneKey: PANE,
          worktreeId: 'wt-1',
          agent: 'claude',
          providerSession: decision.providerSession,
          origin: 'live'
        }
      }
    }
    const row = { providerSession: decision.providerSession, worktreeId: 'wt-1' }
    const restarted = state({
      ...pane,
      agentStatusByPaneKey: {
        [PANE]: { ...row, state: 'working', restoredUnconfirmed: true, stateStartedAt: 0 }
      }
    })
    const asking = { ...decision, endedAt: null }
    // Before: queued as a next message for the same pane, which never takes it mid-question.
    expect(decisionDelivery(restarted, asking)).toEqual({ kind: 'unreachable' })
    // 5 Oct: no status had reached the window yet, and the live record was taken as an exit.
    expect(decisionDelivery(state(pane), asking)).toEqual({ kind: 'unreachable' })
    // A finished row restored from before the question carries no restored flag; its time tells.
    const staleDone = state({
      ...pane,
      agentStatusByPaneKey: { [PANE]: { ...row, state: 'done', stateStartedAt: 0 } }
    })
    expect(decisionDelivery(staleDone, asking)).toEqual({ kind: 'unreachable' })
  })

  it('still sends it as the next message once the conversation was resumed in its own pane', () => {
    // The agent ended while it waited (endedAt), then the same pane resumed the conversation.
    const resumedHere = state({
      agentStatusByPaneKey: {
        [PANE]: { state: 'done', providerSession: decision.providerSession, worktreeId: 'wt-1' }
      },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } }
    })
    expect(decisionDelivery(resumedHere, decision)).toEqual({
      kind: 'message',
      worktreeId: 'wt-1',
      paneKey: PANE
    })
  })

  it('does not take a child’s activity after a restart for the asker moving on', () => {
    // A subagent keeps working while the asker waits on its selector: a fresh working row.
    const childBusy = state({
      agentStatusByPaneKey: {
        [PANE]: {
          state: 'working',
          stateStartedAt: 10,
          providerSession: decision.providerSession,
          worktreeId: 'wt-1'
        }
      },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } }
    })
    expect(decisionDelivery(childBusy, { ...decision, endedAt: null })).toEqual({
      kind: 'unreachable'
    })
  })

  it('never resumes from a quit or live record: that pane still exists and restores itself', () => {
    const record = (origin: string, paneKey = PANE) => ({
      paneKey,
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: decision.providerSession,
      origin
    })
    for (const origin of ['quit', 'live']) {
      expect(
        decisionDelivery(
          state({ sleepingAgentSessionsByPaneKey: { [PANE]: record(origin) } }),
          decision
        )
      ).toEqual({ kind: 'unreachable' })
      // Another pane holding the same conversation keeps it too.
      const other = `tab-2:${NEW_LEAF}`
      expect(
        decisionDelivery(
          state({ sleepingAgentSessionsByPaneKey: { [other]: record(origin, other) } }),
          decision
        )
      ).toEqual({ kind: 'unreachable' })
    }
    const slept = record('worktree-sleep')
    expect(
      decisionDelivery(state({ sleepingAgentSessionsByPaneKey: { [PANE]: slept } }), decision)
    ).toEqual({ kind: 'resume', record: slept })
  })

  it('says it cannot when there is nothing to resume', () => {
    expect(decisionDelivery(state(), { ...decision, providerSession: null })).toEqual({
      kind: 'unreachable'
    })
    expect(decisionDelivery(state(), { ...decision, agent: 'not-an-agent' })).toEqual({
      kind: 'unreachable'
    })
  })
})

describe('an answer to an ended session', () => {
  it('resumes it in a background tab, queues the answer there and clears the question', async () => {
    mocks.state = state({ terminalLayoutsByTabId: {} })
    mocks.launch.mockImplementation(
      (_record, options: { onSessionLaunched: (tabId: string) => void }) => {
        ;(
          mocks.state as { terminalLayoutsByTabId: Record<string, unknown> }
        ).terminalLayoutsByTabId['tab-9'] = {
          root: { type: 'leaf', leafId: NEW_LEAF },
          activeLeafId: NEW_LEAF
        }
        options.onSessionLaunched('tab-9')
        return true
      }
    )
    const delivery = decisionDelivery(state(), decision)
    if (delivery.kind !== 'resume') {
      throw new Error('expected a resume')
    }
    const queued = await deliverDecisionAsMessage(
      decision,
      delivery,
      { questions: decision.questions },
      [{ indices: [0] }]
    )
    expect(queued).toBe(true)
    expect(mocks.launch).toHaveBeenCalledWith(
      delivery.record,
      expect.objectContaining({ suppressNavigation: true })
    )
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { worktreeId: 'wt-1', paneKey: `tab-9:${NEW_LEAF}`, kind: 'pty' },
      expect.stringContaining('"Ship now?" → Yes')
    )
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'sessionDecisions.resolve', {
      key: decision.key
    })
  })

  it('reports failure and keeps the question when the session cannot be resumed', async () => {
    mocks.launch.mockReturnValue(false)
    const delivery = decisionDelivery(state(), decision)
    if (delivery.kind !== 'resume') {
      throw new Error('expected a resume')
    }
    await expect(
      deliverDecisionAsMessage(decision, delivery, { questions: decision.questions }, [
        { indices: [1] }
      ])
    ).resolves.toBe(false)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
