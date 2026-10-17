/**
 * The two readings one observation answers: "did a turn finish?" and "is anything running?".
 *
 * Round-4 live sim (`evidence/na-live-phase1-20260918T063329Z`): a brand-new Claude Code pane —
 * Session details "Agent Claude idle · Finished its turn" — was read as BUSY for as long as it
 * stayed open ("NOW working claude · 0/1/2 min", cli/10k, 10o) and the typed `/next` queued
 * against it sat undelivered for ~95 s until a turn was injected by hand (cli/13d). The pane had
 * no finished turn to build on (`ready: false`, honestly), but nothing was in flight either.
 *
 * Every case below is that distinction, in both directions: what is free, and what is not.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loginKilledTurnFromRollout,
  recordLoginKilledTurn,
  setLoginKilledTurnStore
} from '../answer-delivery/login-killed-turns'
import {
  LoginKilledTurnStore,
  loginKilledTurnsPath
} from '../answer-delivery/login-killed-turns-store'
import { observeConversationReadiness } from './conversation-readiness'
import type { ConversationSource } from '../../shared/conversation-source'
import type { OrcaRuntimeService } from './omni-runtime'

type Hook = Record<string, unknown> | null

/** The smallest host one pane can be read from; `terminal: 'lost'` loses the pane itself. */
function host(hook: Hook, terminal: 'running' | 'exited' | 'lost' = 'running'): OrcaRuntimeService {
  return {
    resolveTerminalPane: () => {
      if (terminal === 'lost') {
        throw new Error('the pane is gone')
      }
      return { handle: 'h1', worktreeId: 'wt' }
    },
    getFreshAgentHookStatusForHandle: () => hook,
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: terminal, tail: ['bye'] })
  } as unknown as OrcaRuntimeService
}

let panes = 0
/** A fresh pane key per case: the busy-since fallback is remembered per pane on purpose. */
function conversation(): ConversationSource {
  panes += 1
  return { kind: 'pty', worktreeId: 'wt', paneKey: `tab-1:leaf-${panes}` }
}

const DONE = { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' }

describe('a conversation with nothing in flight', () => {
  it('is FREE on a fresh agent that has only reported its session boundary', async () => {
    const reading = await observeConversationReadiness(
      host({ ...DONE, sessionBoundary: true }),
      conversation()
    )
    // No finished turn to build on — and nothing running, so the person's message may go.
    expect(reading).toMatchObject({ ready: false, free: true, unverifiable: false })
    expect(reading.busySince).toBeUndefined()
    expect(reading.version).toBeUndefined()
  })

  it('is FREE on a pane with no agent hook row at all', async () => {
    // A live PTY is evidence the pane exists, never evidence that a TURN is in flight.
    expect(await observeConversationReadiness(host(null), conversation())).toMatchObject({
      ready: false,
      free: true
    })
  })

  it('is free WITH a turn identity once a real turn has finished', async () => {
    const reading = await observeConversationReadiness(host(DONE), conversation())
    expect(reading).toMatchObject({ ready: true, free: true })
    expect(reading.version).toEqual(expect.any(String))
  })
})

describe('a conversation that is not free', () => {
  const busy: { name: string; hook: Hook; terminal?: 'lost' }[] = [
    { name: 'the agent is working', hook: { state: 'working', stateStartedAt: 5 } },
    { name: 'the agent is blocked', hook: { state: 'blocked' } },
    { name: 'the agent is waiting for the person', hook: { state: 'waiting' } },
    {
      name: 'the agent is asking the person something',
      hook: { ...DONE, sessionBoundary: true, interactivePrompt: 'Allow this edit?' }
    },
    { name: 'the last turn was interrupted', hook: { ...DONE, interrupted: true } },
    { name: 'the last turn failed', hook: { ...DONE, failed: true } },
    { name: 'no reading can be made at all', hook: null, terminal: 'lost' }
  ]

  it.each(busy)('holds on $name', async (row) => {
    const reading = await observeConversationReadiness(
      host(row.hook, row.terminal ?? 'running'),
      conversation()
    )
    expect(reading.free).toBe(false)
    expect(reading.ready).toBe(false)
  })

  it('carries the turn start and the activity while the agent works', async () => {
    const reading = await observeConversationReadiness(
      host({ state: 'working', stateStartedAt: 1_000, prompt: 'Fix the gate\nthen explain' }),
      conversation(),
      5_000
    )
    expect(reading).toMatchObject({ free: false, busySince: 1_000, activity: 'Fix the gate' })
  })
})

it('releases the remembered busy clock as soon as the pane reads free', async () => {
  const source = conversation()
  // No state stamp: the host remembers the first moment it saw this pane busy.
  const working = await observeConversationReadiness(host({ state: 'working' }), source, 1_000)
  expect(working).toMatchObject({ free: false, busySince: 1_000 })
  // A boundary is free, so the next reading reports no elapsed at all — and a later busy
  // reading starts its own clock instead of inheriting the first one.
  const freed = await observeConversationReadiness(
    host({ ...DONE, sessionBoundary: true }),
    source,
    2_000
  )
  expect(freed.free).toBe(true)
  expect(freed.busySince).toBeUndefined()
  expect(
    await observeConversationReadiness(host({ state: 'working' }), source, 3_000)
  ).toMatchObject({ free: false, busySince: 3_000 })
})

describe('why the last turn failed', () => {
  it('names a login failure, which the classifier alone misses', async () => {
    const reading = await observeConversationReadiness(
      host({ ...DONE, failed: true, failureReason: 'OAuth token has expired.' }),
      conversation()
    )
    expect(reading).toMatchObject({ free: false, failureKind: 'authentication' })
  })

  it('keeps a usage limit a usage limit', async () => {
    const reading = await observeConversationReadiness(
      host({ ...DONE, failed: true, failureReason: "You've hit your limit · resets 5pm" }),
      conversation()
    )
    expect(reading).toMatchObject({ free: false, failureKind: 'usage-limit' })
  })

  it('ends a Codex turn that still reads working once its rollout recorded a login failure', async () => {
    const store = new LoginKilledTurnStore(
      loginKilledTurnsPath(mkdtempSync(join(tmpdir(), 'login-killed-')))
    )
    setLoginKilledTurnStore(store)
    const source = conversation()
    const working = host({ state: 'working', stateStartedAt: 1_000 })
    expect((await observeConversationReadiness(working, source)).failureKind).toBeUndefined()
    recordLoginKilledTurn(
      loginKilledTurnFromRollout(
        {
          paneKey: source.paneKey,
          worktreeId: 'wt',
          sessionId: 'thread-1',
          transcriptPath: '/Users/maintainer/.codex/sessions/2026/10/11/rollout-thread-1.jsonl'
        },
        { failedAt: 2_000, reason: 'Please sign in again.', usageLimit: false },
        { stateStartedAt: 1_000, interactive: false }
      )
    )
    expect(await observeConversationReadiness(working, source)).toMatchObject({
      free: false,
      failureKind: 'authentication'
    })
    setLoginKilledTurnStore(null)
  })
})
