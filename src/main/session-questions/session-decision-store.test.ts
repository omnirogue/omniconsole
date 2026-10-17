import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  SESSION_DECISIONS_FILE,
  SessionDecisionStore,
  sessionDecisionKey
} from './session-decision-store'

const ASK = JSON.stringify({
  questions: [
    { question: 'Ship now?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }
  ]
})
const PANE = 'tab-1:3f1c7a52-8f58-4b3b-9d8a-2d8a6f3a9b10'
const SESSION = { key: 'session_id' as const, id: 'claude-1', transcriptPath: '/tmp/t.jsonl' }

function event(patch: Partial<AgentHookEventPayload> = {}, payload: Record<string, unknown> = {}) {
  return {
    paneKey: PANE,
    connectionId: null,
    worktreeId: 'wt-1',
    providerSession: SESSION,
    toolUseId: 'toolu_1',
    hookEventName: 'PreToolUse',
    ...patch,
    payload: {
      state: 'waiting',
      prompt: '',
      agentType: 'claude',
      toolName: 'AskUserQuestion',
      interactivePrompt: ASK,
      lastAssistantMessage: 'I merged the fix. One choice left.',
      ...payload
    }
  } as AgentHookEventPayload
}

function moved(name: string, patch: Partial<AgentHookEventPayload> = {}) {
  return event(
    { hookEventName: name, toolUseId: undefined, ...patch },
    {
      state: 'working',
      interactivePrompt: undefined,
      toolName: 'Bash'
    }
  )
}

describe('SessionDecisionStore', () => {
  let directory: string
  let now: number
  let store: SessionDecisionStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'session-decisions-'))
    now = 1_000_000
    store = new SessionDecisionStore({ directory, now: () => now })
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('keeps an asked question with its identity, resume handle and the words before it', () => {
    store.observe(event())
    expect(store.list()).toEqual([
      expect.objectContaining({
        key: sessionDecisionKey(PANE, 'claude-1', 'toolu_1', ASK),
        paneKey: PANE,
        worktreeId: 'wt-1',
        agent: 'claude',
        askedAt: now,
        toolUseId: 'toolu_1',
        providerSession: SESSION,
        context: 'I merged the fix. One choice left.',
        endedAt: null
      })
    ])
  })

  it('drops the question once the session acts again: answered or abandoned in the terminal', () => {
    store.observe(event())
    store.observe(moved('PostToolUse'))
    expect(store.list()).toEqual([])
  })

  it('ignores replays, restored rows and a subagent while the question stays open', () => {
    store.observe(event())
    store.observe(moved('PostToolUse', { isReplay: true }))
    store.observe(moved('PostToolUse', { restoredUnconfirmed: true }))
    store.observe(moved('PreToolUse', { toolAgentId: 'agent-7' }))
    store.observe(moved('SubagentStop'))
    expect(store.list()).toHaveLength(1)
  })

  it.each([{ isReplay: true }, { restoredUnconfirmed: true }] as const)(
    'does not recreate a removed question from stale pending evidence %j, including after restart',
    async (provenance) => {
      store.observe(event())
      const answeredKey = store.list()[0]!.key
      expect(store.remove(answeredKey)).toBe(true)
      store.observe(event(provenance))
      expect(store.list()).toEqual([])
      await store.flush()

      const reopened = new SessionDecisionStore({ directory, now: () => now })
      reopened.load()
      reopened.observe(event(provenance))
      expect(reopened.list()).toEqual([])

      // Identical words in a fresh invocation remain a legitimate new question.
      reopened.observe(event({ toolUseId: 'toolu_2' }))
      expect(reopened.list().map((row) => row.key)).toEqual([
        sessionDecisionKey(PANE, SESSION.id, 'toolu_2', ASK)
      ])
      await reopened.flush()
    }
  )

  it.each([{ isReplay: true }, { restoredUnconfirmed: true }] as const)(
    'does not let a stale pending ask replace an outstanding question %j',
    (provenance) => {
      store.observe(event())
      const pending = store.list()[0]!
      store.observe(
        event(
          { ...provenance, toolUseId: 'old-tool' },
          {
            interactivePrompt: JSON.stringify({
              questions: [{ question: 'An older question?', options: [{ label: 'Yes' }] }]
            })
          }
        )
      )
      expect(store.list()).toEqual([pending])
    }
  )

  it('outlives the terminal: a pane teardown or the agent exiting marks it ended', () => {
    store.observe(event())
    now += 5_000
    store.markPaneEnded(PANE)
    expect(store.list()[0]?.endedAt).toBe(now)

    const exited = new SessionDecisionStore({ directory, now: () => now })
    exited.observe(event({ providerSessionOnly: true }))
    expect(exited.list()[0]?.endedAt).toBe(now)
  })

  it('a resumed conversation still owes its answer; a new one in the pane does not', () => {
    store.observe(event())
    // A replay or a subagent's own start says nothing about the process that asked.
    store.observe(moved('SessionStart', { isReplay: true }))
    store.observe(moved('SessionStart', { toolAgentId: 'agent-7' }))
    expect(store.list()[0]?.endedAt).toBeNull()
    store.observe(moved('SessionStart'))
    expect(store.list()).toHaveLength(1)
    // Why ended: the asker is gone, so Work sends the answer as the next message, not keys.
    expect(store.list()[0]?.endedAt).toBe(now)
    store.observe(moved('SessionStart', { providerSession: { key: 'session_id', id: 'claude-2' } }))
    expect(store.list()).toEqual([])
  })

  it('resumed in another pane: the same conversation acting there resolves it too', () => {
    store.observe(event())
    store.markPaneEnded(PANE)
    store.observe(
      moved('UserPromptSubmit', { paneKey: 'tab-9:9d1c7a52-8f58-4b3b-9d8a-2d8a6f3a9b10' })
    )
    expect(store.list()).toEqual([])
  })

  it('keeps the question while the pane that asked still waits, even when a second process on the conversation moves on', () => {
    // Why: a duplicate `--resume` of a conversation whose prompt is still open elsewhere starts a
    // new turn there (2026-10-04, conversation b504af61); the first pane still holds the prompt.
    const asking = new Set([PANE])
    store = new SessionDecisionStore({
      directory,
      now: () => now,
      paneStillAsking: (paneKey, interactivePrompt) =>
        asking.has(paneKey) && interactivePrompt === ASK
    })
    store.observe(event())
    const key = sessionDecisionKey(PANE, 'claude-1', 'toolu_1', ASK)
    store.observe(moved('UserPromptSubmit', { paneKey: 'tab-2:leaf' }))
    store.observe(moved('Stop', { paneKey: 'tab-2:leaf' }))
    expect(store.list().map((row) => [row.key, row.paneKey])).toEqual([[key, PANE]])

    // The second pane repeating the same question (a restored copy) does not take it over.
    store.observe(event({ paneKey: 'tab-2:leaf', toolUseId: undefined }))
    expect(store.list().map((row) => [row.key, row.paneKey])).toEqual([[key, PANE]])

    // Once the asking pane no longer waits, the conversation acting elsewhere resolves it.
    asking.clear()
    store.observe(moved('Stop', { paneKey: 'tab-2:leaf' }))
    expect(store.list()).toEqual([])
  })

  it('still lets a resumed conversation resolve a question whose pane ended', () => {
    store = new SessionDecisionStore({
      directory,
      now: () => now,
      paneStillAsking: () => true
    })
    store.observe(event())
    store.markPaneEnded(PANE)
    store.observe(moved('Stop', { paneKey: 'tab-2:leaf' }))
    expect(store.list()).toEqual([])
  })

  it('keeps one identity when a later event about the same question omits its tool id', () => {
    store.observe(event())
    const key = store.list()[0]!.key
    now += 1_000
    store.observe(event({ toolUseId: undefined, hookEventName: 'PermissionRequest' }))
    expect(store.list().map((row) => [row.key, row.askedAt])).toEqual([[key, 1_000_000]])
  })

  it('keeps one identity while an async question stays open across the agent’s later tool calls', () => {
    store.observe(event())
    const key = store.list()[0]!.key
    store.observe(event({ toolUseId: 'call_exec_2', hookEventName: 'PreToolUse' }))
    store.observe(event({ toolUseId: 'call_exec_3', hookEventName: 'PostToolUse' }))
    expect(store.list().map((row) => [row.key, row.toolUseId])).toEqual([[key, 'toolu_1']])
  })

  it('does not rewrite or restamp a pending question re-observed unchanged', async () => {
    store.observe(event())
    await store.flush()
    const file = join(directory, SESSION_DECISIONS_FILE)
    rmSync(file)
    now += 60_000
    store.observe(event())
    store.observe(event({ toolUseId: 'call_exec_2', hookEventName: 'PostToolUse' }))
    await store.flush()
    expect(existsSync(file)).toBe(false)
    expect(store.list()[0]!.updatedAt).toBe(1_000_000)
    store.observe(event({}, { lastAssistantMessage: 'New words.' }))
    await store.flush()
    expect(existsSync(file)).toBe(true)
    expect(store.list()[0]!.updatedAt).toBe(1_060_000)
  })

  it('a new question in the pane replaces the older one', () => {
    store.observe(event())
    const second = JSON.stringify({
      questions: [{ question: 'Which one?', multiSelect: false, options: [{ label: 'A' }] }]
    })
    store.observe(event({ toolUseId: 'toolu_2' }, { interactivePrompt: second }))
    expect(store.list().map((row) => row.toolUseId)).toEqual(['toolu_2'])
  })

  it('retains unanswered questions across a restart regardless of their age', async () => {
    store.observe(event())
    await store.flush()
    expect(
      JSON.parse(readFileSync(join(directory, SESSION_DECISIONS_FILE), 'utf8')).records
    ).toHaveLength(1)
    const reopened = new SessionDecisionStore({ directory, now: () => now })
    reopened.load()
    expect(reopened.list()).toHaveLength(1)
    const later = new SessionDecisionStore({
      directory,
      now: () => now + 30 * 24 * 60 * 60 * 1000
    })
    later.load()
    expect(later.list()).toEqual(reopened.list())
  })

  it('keeps an old ended question when unrelated sessions ask new questions', async () => {
    store.observe(event())
    store.markPaneEnded(PANE)
    const old = store.list()[0]!
    now += 30 * 24 * 60 * 60 * 1000
    store.observe(event({ paneKey: 'other-pane', providerSession: { ...SESSION, id: 'other' } }))
    expect(store.get(old.key)).toEqual(old)
    await store.flush()
    const reopened = new SessionDecisionStore({ directory, now: () => now })
    reopened.load()
    expect(reopened.get(old.key)).toEqual(old)
    expect(reopened.list()).toHaveLength(2)
    reopened.remove(old.key)
    await reopened.flush()
    const afterDismissal = new SessionDecisionStore({ directory, now: () => now })
    afterDismissal.load()
    expect(afterDismissal.get(old.key)).toBeUndefined()
    expect(afterDismissal.list()).toHaveLength(1)
  })

  it('retains every outstanding identity when more than 200 sessions ask', async () => {
    for (let index = 0; index < 205; index++) {
      store.observe(
        event({
          paneKey: `pane-${index}`,
          providerSession: { ...SESSION, id: `session-${index}` }
        })
      )
      now += 1
    }
    expect(store.list()).toHaveLength(205)
    await store.flush()
    const reopened = new SessionDecisionStore({ directory, now: () => now })
    reopened.load()
    expect(reopened.list()).toEqual(store.list())
    expect(reopened.get(sessionDecisionKey('pane-0', 'session-0', 'toolu_1', ASK))).toBeDefined()
  })

  it('removes an answered or dismissed question and keeps its JEV reading until then', () => {
    store.observe(event())
    const key = store.list()[0]!.key
    store.setScores(
      key,
      { impact: 0.5, risk: 0.25, effort: 0.25, model: 'jev-1.13.0', at: now },
      null
    )
    expect(store.get(key)?.scores?.risk).toBe(0.25)
    store.observe(event())
    expect(store.get(key)?.scores?.risk).toBe(0.25)
    expect(store.remove(key)).toBe(true)
    expect(store.remove(key)).toBe(false)
  })
})
