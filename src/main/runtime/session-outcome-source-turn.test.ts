import { expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { observeSessionOutcomeSource } from './session-outcome-source'

const chain = { sourcePaneKey: 'tab:leaf', worktreeId: 'work' } as SessionChain
function fixture() {
  const hook = vi
    .fn()
    .mockReturnValue({ state: 'done', stateStartedAt: 100, lastAssistantMessage: 'Done.' })
  const incarnation = vi.fn().mockReturnValue('pty:incarnation1')
  const pane = vi.fn().mockReturnValue('tab:leaf')
  const runtime = {
    resolveTerminalPane: () => ({ handle: 'source', worktreeId: 'work' }),
    getTerminalPaneKey: pane,
    getTerminalProcessIncarnation: incarnation,
    getFreshAgentHookStatusForHandle: hook
  } as unknown as OrcaRuntimeService
  return {
    hook,
    incarnation,
    pane,
    observe: () => observeSessionOutcomeSource(runtime, chain, { successfulOnly: true })
  }
}

it('pins identical final text to its actual source turn and remains stable across pings', async () => {
  const f = fixture()
  const original = await f.observe()
  expect(original.ready).toBe(true)
  f.hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 100,
    updatedAt: 200,
    lastAssistantMessage: 'Done.'
  })
  expect((await f.observe()).version).toBe(original.version)
  f.hook.mockReturnValue({ state: 'done', stateStartedAt: 300, lastAssistantMessage: 'Done.' })
  expect((await f.observe()).version).not.toBe(original.version)
})

it('distinguishes replacement processes and actual source panes with identical text and timestamps', async () => {
  const f = fixture()
  const original = await f.observe()
  f.incarnation.mockReturnValue('pty:incarnation2')
  expect((await f.observe()).version).not.toBe(original.version)
  f.incarnation.mockReturnValue('pty:incarnation1')
  f.pane.mockReturnValue('other:leaf')
  expect((await f.observe()).version).not.toBe(original.version)
})

it.each([
  { interrupted: true },
  { failed: true },
  { failed: true, failureReason: 'API usage limit reached.' },
  { sessionBoundary: true },
  { interactivePrompt: 'Choose an option' }
])('refuses a done row with unfinished source semantics: %j', async (extra) => {
  const f = fixture()
  f.hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 100,
    lastAssistantMessage: 'Done.',
    ...extra
  })
  expect(await f.observe()).toMatchObject({ ready: false })
})

it('requires the actual process and completed-state timestamp', async () => {
  const f = fixture()
  f.incarnation.mockReturnValue(null)
  expect(await f.observe()).toMatchObject({ ready: false, unverifiable: true })
  f.incarnation.mockReturnValue('pty:incarnation1')
  f.hook.mockReturnValue({ state: 'done', lastAssistantMessage: 'Done.' })
  expect(await f.observe()).toMatchObject({ ready: false, unverifiable: true })
})

it('retains the provider failure reason until a fresh successful source turn arrives', async () => {
  const f = fixture()
  f.hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 100,
    failed: true,
    failureReason: 'Authentication failed: session expired.',
    lastAssistantMessage: 'Done.'
  })
  expect(await f.observe()).toMatchObject({
    ready: false,
    reason: expect.stringContaining('Authentication failed: session expired.')
  })
  f.hook.mockReturnValue({ state: 'working', stateStartedAt: 200 })
  expect(await f.observe()).toMatchObject({ ready: false })
  f.hook.mockReturnValue({ state: 'done', stateStartedAt: 300, lastAssistantMessage: 'Done.' })
  expect(await f.observe()).toMatchObject({ ready: true, version: expect.any(String) })
})
