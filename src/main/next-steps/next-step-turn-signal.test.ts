import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_MESSAGE_TRIMMED_MARKER } from '../../shared/agent-status-field-normalization'
import { _internals } from '../agent-hooks/server'
import { buildBody, PANE } from '../agent-hooks/server.test-fixtures'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  classifyHookTurnSignal,
  classifyStructuredStatus,
  NO_WORKSPACE_REASON,
  type HookTurnEvidence,
  type StructuredTurnFacts
} from './next-step-turn-signal'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

/** The real provider normalization, stamped the way the hook server enriches it. */
function hook(source: 'claude' | 'codex', payload: Record<string, unknown>): HookTurnEvidence {
  const normalized = _internals.normalizeHookPayload(source, buildBody(payload), 'production')
  if (!normalized) {
    throw new Error('hook did not normalize')
  }
  return { ...normalized, stateStartedAt: 1_000 }
}

describe('classifyHookTurnSignal', () => {
  it('a Claude Stop with last_assistant_message is a finished turn', () => {
    hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the parser' })
    const signal = classifyHookTurnSignal(
      hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'Fixed the parser.' })
    )
    expect(signal).toEqual({
      kind: 'finished',
      turn: {
        conversation: { worktreeId: 'wt-1', paneKey: PANE, kind: 'pty' },
        turnKey: `${PANE}@1000`,
        // The host orders turns by the same stamp its key is minted from.
        order: 1000,
        completedAt: 1000,
        agent: 'claude',
        lastAssistantMessage: 'Fixed the parser.',
        replyComplete: true,
        lastUserPrompt: 'Fix the parser'
      }
    })
  })

  it('marks a reply the normalizer had to trim as not the whole one', () => {
    const long = `Start of the reply. ${'Long middle. '.repeat(4_000)}End of the reply.`
    const signal = classifyHookTurnSignal(
      hook('claude', { hook_event_name: 'Stop', last_assistant_message: long })
    )
    expect(signal.kind).toBe('finished')
    const turn = signal.kind === 'finished' ? signal.turn : null
    expect(turn?.lastAssistantMessage).toContain(ASSISTANT_MESSAGE_TRIMMED_MARKER)
    expect(turn?.replyComplete).toBeUndefined()
  })

  it('a Codex Stop with last_assistant_message is a finished turn', () => {
    const signal = classifyHookTurnSignal(
      hook('codex', { hook_event_name: 'Stop', last_assistant_message: 'Summary of what I did.' })
    )
    expect(signal).toMatchObject({
      kind: 'finished',
      turn: { agent: 'codex', lastAssistantMessage: 'Summary of what I did.' }
    })
  })

  it('a Codex or Claude SubagentStop never triggers', () => {
    // Same sequence as the normalization suite: the lead stopped, then a child resumed and stopped.
    hook('codex', { hook_event_name: 'Stop' })
    hook('codex', {
      hook_event_name: 'PreToolUse',
      agent_id: 'child',
      agent_type: 'reviewer',
      tool_name: 'exec_command',
      tool_input: { cmd: 'pnpm test' }
    })
    const codexChild = hook('codex', {
      hook_event_name: 'SubagentStop',
      agent_id: 'child',
      last_assistant_message: 'child done'
    })
    expect(codexChild.payload.state).toBe('done')
    expect(classifyHookTurnSignal(codexChild)).toEqual({ kind: 'ignore' })
    hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'Review it' })
    hook('claude', { hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'reviewer' })
    const claudeChild = hook('claude', {
      hook_event_name: 'SubagentStop',
      agent_id: 'sub-1',
      last_assistant_message: 'sub done'
    })
    expect(classifyHookTurnSignal(claudeChild).kind).not.toBe('finished')
    // Even a child stop that reads `done` with a reply is not the lead's turn.
    expect(
      classifyHookTurnSignal({
        ...claudeChild,
        payload: { ...claudeChild.payload, state: 'done', lastAssistantMessage: 'sub done' }
      })
    ).toEqual({ kind: 'ignore' })
  })

  it('a child event never marks the lead busy or finished, whatever its state', () => {
    const lead = hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    for (const child of [
      { ...lead, toolAgentId: 'sub-1', payload: { ...lead.payload, state: 'working' as const } },
      {
        ...lead,
        hookEventName: 'SubagentStart',
        payload: { ...lead.payload, state: 'working' as const }
      },
      { ...lead, hookEventName: 'TeammateIdle' },
      { ...lead, toolAgentId: 'sub-1' }
    ]) {
      expect(classifyHookTurnSignal(child)).toEqual({ kind: 'ignore' })
    }
  })

  it('ignores replays and restored rows, and reads a working row as busy', () => {
    const stop = hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    expect(classifyHookTurnSignal({ ...stop, isReplay: true })).toEqual({ kind: 'ignore' })
    expect(classifyHookTurnSignal({ ...stop, restoredUnconfirmed: true })).toEqual({
      kind: 'ignore'
    })
    const working = hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    expect(classifyHookTurnSignal(working)).toMatchObject({ kind: 'busy' })
  })

  it('names why a finished turn gets no suggestions', () => {
    const base = hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    const reasonOf = (payload: Partial<HookTurnEvidence['payload']>) => {
      const signal = classifyHookTurnSignal({ ...base, payload: { ...base.payload, ...payload } })
      return signal.kind === 'skip' ? signal.reason : signal.kind
    }
    expect(reasonOf({ failed: true, failureReason: 'usage limit reached' })).toMatch(
      /stopped without finishing: usage limit/
    )
    expect(reasonOf({ interrupted: true })).toMatch(/interrupted/)
    expect(reasonOf({ interactivePrompt: '{"q":1}' })).toMatch(/waiting for an answer/)
    expect(reasonOf({ lastAssistantMessageIsToolOutput: true })).toMatch(/from a tool/)
    expect(reasonOf({ lastAssistantMessage: '  ' })).toMatch(/without a reply/)
    expect(reasonOf({ sessionBoundary: true })).toBe('ignore')
    expect(classifyHookTurnSignal({ ...base, worktreeId: undefined })).toMatchObject({
      kind: 'skip',
      reason: NO_WORKSPACE_REASON
    })
  })

  it('keys one turn by its completion stamp so repeated done pings share one key', () => {
    const stop = hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    const first = classifyHookTurnSignal(stop)
    const again = classifyHookTurnSignal({ ...stop, payload: { ...stop.payload } })
    const gated = classifyHookTurnSignal({
      ...stop,
      payload: { ...stop.payload, turnCompletedAt: 5 }
    })
    expect(first.kind === 'finished' && first.turn.turnKey).toBe(`${PANE}@1000`)
    expect(again.kind === 'finished' && again.turn.turnKey).toBe(`${PANE}@1000`)
    expect(gated.kind === 'finished' && gated.turn.turnKey).toBe(`${PANE}@5`)
  })
})

describe('classifyStructuredStatus', () => {
  const summary = (over: Partial<AgentSessionStatusSummary>): AgentSessionStatusSummary => ({
    sessionId: 'sess-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'Add tests',
    lastAssistantMessage: 'Added tests.',
    updatedAt: 10,
    ...over
  })

  const settled = (over: Partial<StructuredTurnFacts> = {}): StructuredTurnFacts => ({
    running: false,
    hasTurn: true,
    awaitingStart: false,
    outcome: 'completed',
    lastSequence: 42,
    ...over
  })

  it('fires on working → idle for Claude and Codex chats alike', () => {
    for (const agent of ['claude', 'codex'] as const) {
      expect(classifyStructuredStatus('working', summary({ agent }), settled())).toMatchObject({
        kind: 'finished',
        turn: {
          conversation: { kind: 'structured', sessionId: 'sess-1', worktreeId: 'wt-1' },
          turnKey: expect.stringMatching(/@42$/),
          agent,
          lastUserPrompt: 'Add tests'
        }
      })
    }
  })

  it('only a completed outcome is a finished turn; any other settled outcome is skipped', () => {
    expect(classifyStructuredStatus('working', summary({}), settled())).toMatchObject({
      kind: 'finished'
    })
    for (const outcome of ['failed', 'interrupted', 'cancelled', 'timeout', 'error']) {
      expect(classifyStructuredStatus('working', summary({}), settled({ outcome }))).toMatchObject({
        kind: 'skip',
        reason: expect.any(String)
      })
    }
    expect(
      classifyStructuredStatus(
        'working',
        summary({ failureReason: 'quota' }),
        settled({ outcome: 'failed' })
      )
    ).toMatchObject({ reason: expect.stringMatching(/quota/) })
  })

  it('a submit flicker or an unsettled turn is not a finished turn', () => {
    for (const turn of [
      settled({ awaitingStart: true }),
      settled({ running: true }),
      settled({ hasTurn: false }),
      settled({ outcome: 'unknown' }),
      null
    ]) {
      expect(classifyStructuredStatus('working', summary({}), turn)).toEqual({ kind: 'ignore' })
    }
  })

  it('does not fire without an observed working edge, and skips failed turns', () => {
    expect(classifyStructuredStatus(undefined, summary({}), settled())).toEqual({ kind: 'ignore' })
    expect(classifyStructuredStatus('attention', summary({}), settled())).toEqual({
      kind: 'ignore'
    })
    expect(classifyStructuredStatus('working', summary({ failed: true }), settled())).toMatchObject(
      { kind: 'skip' }
    )
    expect(
      classifyStructuredStatus('working', summary({}), settled({ outcome: 'interrupted' }))
    ).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/interrupted/) })
    expect(
      classifyStructuredStatus('idle', summary({ status: 'working' }), settled())
    ).toMatchObject({ kind: 'busy' })
  })
})
