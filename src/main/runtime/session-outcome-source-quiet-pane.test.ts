/**
 * A live pane whose agent reports no hook row (`reports/handoff-diagnosis.md`, D2).
 *
 * The run waited for ever on `{ready:false, idle:true}`: no reason, no wake, no way out. These are
 * the readings the host can make by itself, in both directions — what becomes ready, and what must
 * never be read as a finished turn.
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { observeSessionOutcomeSource } from './session-outcome-source'
import {
  SOURCE_IDLE_SETTLE_MS,
  SOURCE_QUIET_PANE_MS,
  SOURCE_TURN_WAIT
} from './session-outcome-source-quiet-pane'

const T0 = 1_000_000
const chain = { sourcePaneKey: 'tab:leaf', worktreeId: 'work' } as SessionChain

type Pane = {
  status: 'idle' | 'working' | 'permission' | null
  /** `null`: evaluated, nothing pending. `undefined`: the host could not evaluate the pane. */
  wait: { source: 'prompt-text' } | null | undefined
  tail: string[]
  incarnation: string
  /** The status probe fails (a stale handle, a wedged remote host): nothing was read at all. */
  statusUnreadable: boolean
}

function host(initial: Partial<Pane> = {}) {
  const pane: Pane = {
    status: 'idle',
    wait: null,
    tail: ['> '],
    incarnation: 'pty:1',
    statusUnreadable: false,
    ...initial
  }
  const runtime = {
    resolveTerminalPane: () => ({ handle: 'source', worktreeId: 'work' }),
    getFreshAgentHookStatusForHandle: () => null,
    getTerminalPaneKey: () => 'tab:leaf',
    getTerminalProcessIncarnation: () => pane.incarnation,
    readTerminal: async () => ({ status: 'running', tail: pane.tail, latestCursor: 'c1' }),
    getTerminalInteractiveWait: async () => pane.wait,
    getTerminalAgentStatus: async () => {
      if (pane.statusUnreadable) {
        throw new Error('terminal_handle_stale')
      }
      return { handle: 'source', isRunningAgent: pane.status !== null, status: pane.status }
    }
  } as unknown as OrcaRuntimeService
  return {
    pane,
    observe: (now: number, options: { successfulOnly?: boolean } = {}) =>
      observeSessionOutcomeSource(runtime, chain, { now, ...options })
  }
}

describe('an idle agent that never reported a hook row', () => {
  it('is never silent, and becomes ready once it has sat at its own prompt', async () => {
    const f = host()
    // The first reading cannot tell a finished turn from a message sent a moment ago.
    expect(await f.observe(T0)).toEqual({
      ready: false,
      idle: true,
      settling: true,
      wait: SOURCE_TURN_WAIT
    })
    expect(await f.observe(T0 + SOURCE_IDLE_SETTLE_MS - 1)).toMatchObject({ ready: false })

    const ready = await f.observe(T0 + SOURCE_IDLE_SETTLE_MS)
    expect(ready).toEqual({ ready: true, version: expect.stringMatching(/^[a-f0-9]{64}$/) })
    // The identity of that ending is stable for as long as the pane does not move.
    expect((await f.observe(T0 + 10 * 60_000)).version).toBe(ready.version)
  })

  it('names a later ending as a different turn', async () => {
    const f = host()
    await f.observe(T0)
    const first = await f.observe(T0 + SOURCE_IDLE_SETTLE_MS)
    f.pane.tail = ['> ', 'A second answer.']
    expect(await f.observe(T0 + 60_000)).toMatchObject({ ready: false, settling: true })
    const second = await f.observe(T0 + 60_000 + SOURCE_IDLE_SETTLE_MS)
    expect(second.ready).toBe(true)
    expect(second.version).not.toBe(first.version)
  })

  it('starts over when the process in the pane is replaced', async () => {
    const f = host()
    await f.observe(T0)
    f.pane.incarnation = 'pty:2'
    expect(await f.observe(T0 + SOURCE_IDLE_SETTLE_MS)).toMatchObject({ ready: false })
    expect(await f.observe(T0 + 2 * SOURCE_IDLE_SETTLE_MS)).toMatchObject({ ready: true })
  })
})

describe('an agent that is visibly working or asking something', () => {
  it.each([
    ['working', { status: 'working' as const }, undefined],
    ['showing a permission prompt', { status: 'permission' as const }, 'needs your input'],
    ['parked on a question', { wait: { source: 'prompt-text' as const } }, 'needs your input']
  ])('is not ready and not free while it is %s, however long it lasts', async (_n, state, why) => {
    const f = host(state)
    for (const at of [T0, T0 + SOURCE_QUIET_PANE_MS, T0 + 10 * SOURCE_QUIET_PANE_MS]) {
      const reading = await f.observe(at)
      expect(reading).toMatchObject({ ready: false, wait: SOURCE_TURN_WAIT })
      expect(reading.idle).toBeUndefined()
      expect(reading.version).toBeUndefined()
      if (why) {
        expect(reading.reason).toContain(why)
      }
    }
  })

  it('does not count the time it worked toward the quiet period that follows', async () => {
    const f = host()
    await f.observe(T0)
    f.pane.status = 'working'
    await f.observe(T0 + 1_000)
    f.pane.status = 'idle'
    expect(await f.observe(T0 + SOURCE_IDLE_SETTLE_MS)).toMatchObject({ ready: false })
    expect(await f.observe(T0 + 2 * SOURCE_IDLE_SETTLE_MS)).toMatchObject({ ready: true })
  })
})

describe('an agent the host can read no status from', () => {
  it('is ready only after the pane has been provably quiet for the bounded time', async () => {
    const f = host({ status: null })
    expect(await f.observe(T0)).toMatchObject({ ready: false, wait: SOURCE_TURN_WAIT })
    expect(await f.observe(T0 + SOURCE_IDLE_SETTLE_MS)).toMatchObject({ ready: false })
    expect(await f.observe(T0 + SOURCE_QUIET_PANE_MS - 1)).toMatchObject({ ready: false })
    expect(await f.observe(T0 + SOURCE_QUIET_PANE_MS)).toMatchObject({
      ready: true,
      version: expect.any(String)
    })
  })

  it('never qualifies while the pane keeps moving: a spinner is a turn in flight', async () => {
    const f = host({ status: null })
    for (let pass = 0; pass <= 40; pass++) {
      f.pane.tail = [`working ${pass}`]
      expect(await f.observe(T0 + pass * 2_000)).toMatchObject({ ready: false })
    }
  })

  it('never counts a quiet shell with no agent in it where only a successful turn counts', async () => {
    const f = host({ status: null })
    const later = T0 + 10 * SOURCE_QUIET_PANE_MS
    await f.observe(T0, { successfulOnly: true })
    expect(await f.observe(later, { successfulOnly: true })).toMatchObject({
      ready: false,
      settling: true
    })
    // A reader that does not need a successful turn reads the same quiet pane as finished.
    expect(await f.observe(later)).toMatchObject({ ready: true })
  })

  it.each([
    ['check for a pending question', { status: null, wait: undefined }],
    ['read an agent status from', { statusUnreadable: true }]
  ] as const)('never reads a pane it could not %s as finished', async (_n, state) => {
    const f = host(state)
    await f.observe(T0)
    expect(await f.observe(T0 + 10 * SOURCE_QUIET_PANE_MS)).toEqual({
      ready: false,
      idle: true,
      settling: true,
      wait: SOURCE_TURN_WAIT
    })
  })
})
