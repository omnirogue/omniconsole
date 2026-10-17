import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  seedClaudeLeadTurnFromPersistedStatus,
  seedClaudeSubagentRosterFromSnapshots
} from './agent-hook-listener/providers/claude-roster-state'
import {
  reconcileRemoteCodexState,
  seedCodexStateFromSnapshot
} from './agent-hook-listener/providers/codex-state'
import { normalizeAgentStatusPayload, pickParsedAgentStatusPayload } from './agent-status-types'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-background', '33333333-3333-4333-8333-333333333333')
const shell = (id: string, status = 'running') => ({ id, type: 'shell', status, command: 'watch' })

function event(state: HookListenerState, source: 'claude' | 'codex', payload: object) {
  return normalizeHookPayload(state, source, { paneKey: PANE, payload }, 'production')?.payload
}

// Why: a finished turn with live background work is Waiting, never Working (Sal, 2026-09-24).
describe('finished turn with live background work', () => {
  it('reports two running shells after a Claude Stop as monitoring with a count of 2', () => {
    const state = createHookListenerState()
    event(state, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'start watchers' })

    const waiting = event(state, 'claude', {
      hook_event_name: 'Stop',
      background_tasks: [shell('b1'), shell('b2'), shell('b3', 'completed')]
    })
    expect(waiting).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      backgroundTaskCount: 2
    })
    expect(typeof waiting?.turnCompletedAt).toBe('number')

    const cleared = event(state, 'claude', {
      hook_event_name: 'Stop',
      background_tasks: [],
      session_crons: []
    })
    expect(cleared?.state).toBe('done')
    expect(cleared?.workingMode).toBeUndefined()
    expect(cleared?.backgroundTaskCount).toBeUndefined()
  })

  it('does not count teammate rows, which report running permanently', () => {
    const state = createHookListenerState()
    expect(
      event(state, 'claude', {
        hook_event_name: 'Stop',
        background_tasks: [shell('b1'), { id: 'team-1', type: 'teammate', status: 'running' }]
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', backgroundTaskCount: 1 })
  })

  it('waits on background subagents alone after the lead turn ends', () => {
    const state = createHookListenerState()
    event(state, 'claude', { hook_event_name: 'SubagentStart', agent_id: 'child-1' })
    event(state, 'claude', { hook_event_name: 'SubagentStart', agent_id: 'child-2' })
    expect(event(state, 'claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual(
      expect.objectContaining({ state: 'working', workingMode: undefined })
    )

    expect(event(state, 'claude', { hook_event_name: 'Stop' })).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      backgroundTaskCount: 2
    })
    expect(
      event(state, 'claude', { hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', backgroundTaskCount: 1 })
    expect(
      event(state, 'claude', { hook_event_name: 'SubagentStop', agent_id: 'child-2' })?.state
    ).toBe('done')
  })

  it('keeps an interrupted Stop with running shells done', () => {
    const state = createHookListenerState()
    const interrupted = event(state, 'claude', {
      hook_event_name: 'Stop',
      is_interrupt: true,
      background_tasks: [shell('b1'), shell('b2')]
    })
    expect(interrupted).toMatchObject({ state: 'done', interrupted: true })
    expect(interrupted?.workingMode).toBeUndefined()
    expect(interrupted?.backgroundTaskCount).toBeUndefined()
  })

  it('shows no number for crons, which are scheduled rather than running', () => {
    const state = createHookListenerState()
    const cron = event(state, 'claude', { hook_event_name: 'Stop', session_crons: [{ id: 'c1' }] })
    expect(cron).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(cron?.backgroundTaskCount).toBeUndefined()
  })

  it('recounts background children restored from persisted status after a restart', () => {
    const state = createHookListenerState()
    const subagents = [
      { id: 'child-1', state: 'working' as const, startedAt: 1 },
      { id: 'child-2', state: 'working' as const, startedAt: 2 }
    ]
    seedClaudeLeadTurnFromPersistedStatus(
      state,
      PANE,
      {
        payload: {
          state: 'working',
          workingMode: 'monitoring',
          backgroundTaskCount: 2,
          prompt: 'fan out',
          agentType: 'claude',
          subagents
        }
      },
      { childOnlyBoundary: true }
    )
    seedClaudeSubagentRosterFromSnapshots(state, PANE, subagents)

    expect(
      event(state, 'claude', { hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', backgroundTaskCount: 1 })
  })

  it('treats Codex children that outlive the lead as background work with a count', () => {
    const state = createHookListenerState()
    event(state, 'codex', { hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    expect(event(state, 'codex', { hook_event_name: 'SubagentStart', agent_id: 'c1' })).toEqual(
      expect.objectContaining({ state: 'working', workingMode: undefined })
    )
    expect(event(state, 'codex', { hook_event_name: 'Stop' })?.state).toBe('done')

    expect(
      event(state, 'codex', { hook_event_name: 'SubagentStart', agent_id: 'c1' })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', backgroundTaskCount: 1 })
    expect(
      event(state, 'codex', { hook_event_name: 'SubagentStart', agent_id: 'c2' })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', backgroundTaskCount: 2 })
    expect(
      event(state, 'codex', {
        hook_event_name: 'PermissionRequest',
        agent_id: 'c2',
        tool_name: 'Bash'
      })
    ).toMatchObject({ state: 'waiting', workingMode: undefined, backgroundTaskCount: undefined })
    event(state, 'codex', { hook_event_name: 'SubagentStop', agent_id: 'c2' })
    expect(event(state, 'codex', { hook_event_name: 'SubagentStop', agent_id: 'c1' })?.state).toBe(
      'done'
    )
  })

  it('restores a finished Codex lead from a persisted monitoring status after a restart', () => {
    const state = createHookListenerState()
    seedCodexStateFromSnapshot(state, PANE, {
      state: 'working',
      workingMode: 'monitoring',
      subagents: [
        { id: 'c1', state: 'working', startedAt: 1 },
        { id: 'c2', state: 'working', startedAt: 2 }
      ]
    })
    expect(
      event(state, 'codex', { hook_event_name: 'SubagentStop', agent_id: 'c2' })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', backgroundTaskCount: 1 })
    expect(event(state, 'codex', { hook_event_name: 'SubagentStop', agent_id: 'c1' })?.state).toBe(
      'done'
    )
  })

  it('re-derives the Codex mode when main reconciles an older relay payload', () => {
    const state = createHookListenerState()
    state.codexLeadStateByPaneKey.set(PANE, { state: 'done' })
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE,
      'SubagentStart',
      'c1',
      {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        subagents: [{ id: 'c1', state: 'working', startedAt: 1 }]
      },
      undefined
    )
    expect(reconciled).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      backgroundTaskCount: 1
    })
  })
})

describe('backgroundTaskCount normalization', () => {
  const monitoring = { state: 'working', workingMode: 'monitoring' }

  it('keeps a positive integer only on a working+monitoring payload', () => {
    expect(normalizeAgentStatusPayload({ ...monitoring, backgroundTaskCount: 2 })).toMatchObject({
      backgroundTaskCount: 2
    })
    expect(
      normalizeAgentStatusPayload({ state: 'working', backgroundTaskCount: 2 })?.backgroundTaskCount
    ).toBeUndefined()
    expect(
      normalizeAgentStatusPayload({ state: 'done', backgroundTaskCount: 2 })?.backgroundTaskCount
    ).toBeUndefined()
  })

  it('floors, clamps to 999, and drops non-positive or non-numeric counts', () => {
    const count = (value: unknown) =>
      normalizeAgentStatusPayload({ ...monitoring, backgroundTaskCount: value })
        ?.backgroundTaskCount
    expect(count(2.7)).toBe(2)
    expect(count(5000)).toBe(999)
    for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      expect(count(value)).toBeUndefined()
    }
  })

  it('survives the client-visible status projection', () => {
    const parsed = normalizeAgentStatusPayload({ ...monitoring, backgroundTaskCount: 3 })!
    expect(pickParsedAgentStatusPayload(parsed)).toMatchObject({ backgroundTaskCount: 3 })
  })
})
