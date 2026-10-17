import { beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  isInconclusiveSessionOutcomeVerification,
  verifySessionOutcomeSession
} from './session-outcome-session-evidence'

const hook = vi.fn()
const read = vi.fn()
const runtime = {
  resolveTerminalPane: () => ({ handle: 'source', worktreeId: 'work' }),
  getTerminalPaneKey: () => 'tab:leaf',
  getTerminalProcessIncarnation: () => 'process:1',
  getFreshAgentHookStatusForHandle: hook,
  readTerminal: read
} as unknown as OrcaRuntimeService
const chain = {
  sourcePaneKey: 'tab:leaf',
  worktreeId: 'work',
  outcomeSet: { continuation: {} }
} as SessionChain
const condition = { id: 'done', kind: 'session', target: 'tab:leaf' } as const
beforeEach(() => {
  vi.clearAllMocks()
  hook.mockReturnValue(undefined)
  read.mockResolvedValue({ status: 'exited', tail: ['done'] })
})

it('requires a successful source receipt, not an exited terminal or claimed text', async () => {
  expect(await verifySessionOutcomeSession(condition, runtime, chain)).toMatchObject({
    verified: false
  })
  hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 10,
    lastAssistantMessage: 'Completed source result.'
  })
  expect(await verifySessionOutcomeSession(condition, runtime, chain)).toMatchObject({
    verified: true,
    receipt: expect.stringContaining('session:tab:leaf:')
  })
})

it.each(['working', 'waiting', 'blocked'])('keeps %s source pending', async (state) => {
  hook.mockReturnValue({ state })
  expect(await verifySessionOutcomeSession(condition, runtime, chain)).toMatchObject({
    verified: false
  })
})

it('refuses another source and an unreachable owning host', async () => {
  expect(
    await verifySessionOutcomeSession({ ...condition, target: 'other' }, runtime, chain)
  ).toMatchObject({ verified: false })
  read.mockRejectedValue(new Error('offline'))
  expect(await verifySessionOutcomeSession(condition, runtime, chain)).toMatchObject({
    verified: false,
    reason: expect.stringContaining('unverifiable')
  })
})

it('reads lost contact, an exited pane and a still-settling pane as inconclusive — never a definite refusal', async () => {
  const inconclusive = async (): Promise<boolean> =>
    isInconclusiveSessionOutcomeVerification(
      await verifySessionOutcomeSession(condition, runtime, chain)
    )
  // The pane exited: with only a successful completion counting, nothing was observed.
  expect(await inconclusive()).toBe(true)
  read.mockRejectedValue(new Error('offline'))
  expect(await inconclusive()).toBe(true)
  // Alive with no hook row, and not yet quiet for long enough to say a turn finished.
  read.mockResolvedValue({ status: 'running', tail: ['> '] })
  expect(await inconclusive()).toBe(true)

  // The source demonstrably moved on: that is an observation, and it may spend earned proof.
  for (const state of ['working', 'waiting', 'blocked']) {
    hook.mockReturnValue({ state })
    expect(await inconclusive()).toBe(false)
  }
  hook.mockReturnValue({ state: 'done', stateStartedAt: 10, interrupted: true })
  expect(await inconclusive()).toBe(false)
  hook.mockReturnValue({ state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Done.' })
  expect(await inconclusive()).toBe(false)
})
