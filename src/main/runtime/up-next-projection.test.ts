/**
 * The Now row says agent · what it is doing · elapsed (v3 amendment 1, binding).
 *
 * It used to say none of them: the projection hard-blanked the agent and the label and
 * never set `elapsedMs`, so a working conversation rendered "Now · working" with an empty
 * secondary and the header notation collapsed to a bare "●". Every field here is a HOST
 * reading — the pane's agent, the prompt its turn is running, the moment that state was
 * entered — and a reading the host cannot make is still left empty rather than guessed.
 *
 * The runtime stub below is this file's own, deliberately: the shared RPC harness answers
 * `conversationAgent` with a constant and mocks readiness away, so it cannot show that the
 * plumbing reaches the pane at all.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import type { UpNextConversationId } from '../../shared/up-next-types'
import { projectUpNext, type UpNextProjectionInput } from './up-next-projection'
import { upNextView } from './up-next'

const START = 1_700_000_000_000

const input = (over: Partial<UpNextProjectionInput> = {}): UpNextProjectionInput => ({
  conversationId: { kind: 'pty', worktreeId: 'wt', paneKey: 'tab-1:leaf-1' },
  rowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
  chain: null,
  queue: null,
  drafts: [],
  busy: true,
  now: START,
  ...over
})

describe('the Now row of a working conversation', () => {
  it('carries the agent, what it is working on, and a growing elapsed', () => {
    const facts = { agent: 'claude', activity: 'Fix the failing gate test', busySince: START }
    const first = projectUpNext(input({ ...facts, now: START + 30_000 }))
    expect(first.now).toEqual({
      kind: 'current-work',
      agent: 'claude',
      label: 'Fix the failing gate test',
      elapsedMs: 30_000
    })
    // Elapsed is measured from the turn's own start, so the same turn read again later
    // reports MORE time, never a fresh zero.
    const later = projectUpNext(input({ ...facts, now: START + 90_000 }))
    expect(later.now).toMatchObject({ elapsedMs: 90_000 })
  })

  it('names the current work in the header notation instead of a bare ●', () => {
    const view = projectUpNext(
      input({ agent: 'claude', activity: 'Fix the failing gate test', busySince: START })
    )
    expect(view.notation).toBe('● Fix the failing gate test')
  })

  it('leaves what the host cannot answer empty, and reports no elapsed at all', () => {
    const view = projectUpNext(input())
    expect(view.now).toEqual({ kind: 'current-work', agent: '', label: '' })
  })

  it('says idle when the conversation is free', () => {
    expect(projectUpNext(input({ busy: false })).now).toEqual({ kind: 'idle' })
  })
})

type Hook = {
  state: 'working' | 'done'
  prompt?: string
  stateStartedAt?: number
  lastAssistantMessage?: string | null
  /** Claude's SessionStart and every connect/resume/clear: landed idle, no turn behind it. */
  sessionBoundary?: boolean
}

/** The smallest host that can be busy: one pane, one agent, one hook row. */
function host(hook: Hook | null, agent: 'claude' | null = 'claude'): OrcaRuntimeService {
  return {
    readUpNextDrafts: () => null,
    listSessionChains: () => [],
    readPromptQueue: () => null,
    conversationAgent: () => agent,
    resolveTerminalPane: () => ({ handle: 'h1', worktreeId: 'wt' }),
    getFreshAgentHookStatusForHandle: () => hook,
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] })
  } as unknown as OrcaRuntimeService
}

const conversation = (paneKey: string): UpNextConversationId => ({
  kind: 'pty',
  worktreeId: 'wt',
  paneKey
})

describe('what upNextView reads off the host', () => {
  it('fills the Now row from the pane, its prompt and the state stamp', async () => {
    const view = await upNextView(
      host({
        state: 'working',
        prompt: 'Fix the failing gate test\nand explain the change',
        stateStartedAt: Date.now() - 45_000
      }),
      conversation('pane-working')
    )
    expect(view.header.state).toBe('running')
    expect(view.now).toMatchObject({
      kind: 'current-work',
      agent: 'claude',
      // One line, bounded: the Now row says what the turn is about, not the whole prompt.
      label: 'Fix the failing gate test'
    })
    expect(view.now.kind === 'current-work' && view.now.elapsedMs).toBeGreaterThanOrEqual(45_000)
  })

  it('measures elapsed from the turn start even when the host names no agent', async () => {
    const view = await upNextView(
      host({ state: 'working', stateStartedAt: Date.now() - 5_000 }, null),
      conversation('pane-anonymous')
    )
    expect(view.now).toMatchObject({ kind: 'current-work', agent: '', label: '' })
    expect(view.now.kind === 'current-work' && view.now.elapsedMs).toBeGreaterThanOrEqual(5_000)
  })

  it('counts an unreadable conversation as busy, from when it was first seen busy', async () => {
    // No pane, no hook: the reading could not be made, which is not evidence the agent is
    // free. There is no state stamp to measure from, so the host uses the first moment it
    // saw the conversation busy — which never runs backwards on the next read.
    const runtime = {
      readUpNextDrafts: () => null,
      listSessionChains: () => [],
      readPromptQueue: () => null,
      conversationAgent: () => 'claude',
      resolveTerminalPane: () => {
        throw new Error('the pane is gone')
      }
    } as unknown as OrcaRuntimeService
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START)
    try {
      const first = await upNextView(runtime, conversation('pane-lost'))
      expect(first.now).toMatchObject({ kind: 'current-work', agent: 'claude', elapsedMs: 0 })
      clock.mockReturnValue(START + 250)
      const second = await upNextView(runtime, conversation('pane-lost'))
      expect(second.now).toMatchObject({ kind: 'current-work', agent: 'claude', elapsedMs: 250 })
    } finally {
      clock.mockRestore()
    }
  })

  it('says idle on a pane whose only reading is its session boundary', async () => {
    // The round-4 live defect: a brand-new Claude Code pane ("Finished its turn" in Session
    // details) read "NOW working claude · 0/1/2 min" from creation onward and stayed that way
    // for as long as it was open (`evidence/na-live-phase1-20260918T063329Z` cli/10k, 10o).
    // There is no finished turn to build on here — and nothing running to report either.
    const view = await upNextView(
      host({ state: 'done', sessionBoundary: true, stateStartedAt: Date.now() - 120_000 }),
      conversation('pane-fresh')
    )
    expect(view.now).toEqual({ kind: 'idle', agent: 'claude' })
    expect(view.header.state).toBe('idle')
  })

  it('says idle on a pane with no agent hook row at all', async () => {
    // A live PTY says the pane exists; it never says a turn is in flight.
    const view = await upNextView(host(null), conversation('pane-hookless'))
    expect(view.now).toEqual({ kind: 'idle', agent: 'claude' })
    expect(view.header.state).toBe('idle')
  })

  it('says idle — naming the agent that waits, with no activity and no elapsed', async () => {
    const view = await upNextView(
      host({ state: 'done', stateStartedAt: Date.now() - 1_000, lastAssistantMessage: 'Done.' }),
      conversation('pane-idle')
    )
    // The row the mockup draws: "Now · idle · <agent> · waiting for you". What belongs to a
    // turn that is RUNNING — the activity and the elapsed — is not carried into it.
    expect(view.now).toEqual({ kind: 'idle', agent: 'claude' })
    expect(view.header.state).toBe('idle')
  })
})
