/**
 * Every authority refusal the five combined PRs each brought, pinned at its own seam.
 *
 * This file exists because combining #291, #289, #269, #283 and #284 rewrote the same
 * readiness and launch paths. A merge that drops one author's refusal still compiles and still
 * passes that author's remaining tests, because the refusal and its proof usually move together.
 * Each case below names the PR it belongs to and fails if that refusal stops firing.
 *
 * R1  #289 an agent-hook `done` turn that was interrupted is not a finished source
 * R2  #289 a structured turn that is interrupted / failed / never settled is not finished
 * R3  #289 a DEFINITE not-ready observation demotes a stored sourceReady
 * R5  #269 `done` across a session boundary or on an interactive prompt is not finished
 * R6  #269 `done` without a complete turn identity is unverifiable, never ready
 * R9  #283 a journal turn with no confirmed admission receipt / pending prompt is not finished
 * R14 #284 with a planning source, a terminal that merely EXITED is not finished
 * R16 #291 an AI commit grants no new side-by-side consent
 * R17 combined: ready only when every available reading agrees
 */
import { afterEach, expect, it } from 'vitest'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { resolveSessionOutcomeSourceReadiness } from './session-outcome-source-readiness'
import { sessionOutcomeParallelConsent } from './session-outcome-concurrency'
import { observeStructuredAgentSessionOutcome } from '../../shared/structured-agent-session-outcome-observation'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId('chat-1'), 'chat-1')

type Hook = Record<string, unknown>

/** A PTY source whose agent hook and terminal read are both under the test's control. */
function ptyRuntime(hook: Hook | null, read: { status: string; tail: string[] }) {
  return {
    resolveTerminalPane: () => ({ handle: 'h', worktreeId: 'wt' }),
    getFreshAgentHookStatusForHandle: () => hook,
    getTerminalPaneKey: () => 'tab:leaf',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => read
  } as unknown as OrcaRuntimeService
}

function chain(continuation: Record<string, unknown> = {}): SessionChain {
  return {
    sourcePaneKey: 'pane',
    worktreeId: 'wt',
    steps: [],
    outcomeSet: { continuation }
  } as unknown as SessionChain
}

const DONE: Hook = { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' }

it('R1 #289 refuses an agent-hook turn that ended by interrupt', async () => {
  const observed = await observeSessionOutcomeSource(
    ptyRuntime({ ...DONE, interrupted: true }, { status: 'running', tail: [] }),
    chain()
  )
  expect(observed.ready).toBe(false)
  expect(observed.reason).toContain('interrupted')
})

it('R5 #269 refuses a done turn across a session boundary or on an interactive prompt', async () => {
  for (const extra of [{ sessionBoundary: true }, { interactivePrompt: 'Which file?' }]) {
    const observed = await observeSessionOutcomeSource(
      ptyRuntime({ ...DONE, ...extra }, { status: 'running', tail: [] }),
      chain()
    )
    expect(observed.ready).toBe(false)
  }
})

it('R6 #269 refuses a done turn whose completed-turn identity is unavailable', async () => {
  const runtime = {
    ...ptyRuntime(DONE, { status: 'running', tail: [] }),
    getTerminalProcessIncarnation: () => undefined
  } as unknown as OrcaRuntimeService
  const observed = await observeSessionOutcomeSource(runtime, chain())
  expect(observed).toMatchObject({ ready: false, unverifiable: true })
})

it('R14 #284 refuses a merely exited terminal when only a success counts', async () => {
  const runtime = ptyRuntime(null, { status: 'exited', tail: ['bye'] })
  await expect(observeSessionOutcomeSource(runtime, chain())).resolves.toMatchObject({
    ready: true
  })
  await expect(
    observeSessionOutcomeSource(runtime, chain(), { successfulOnly: true })
  ).resolves.toMatchObject({ ready: false, unverifiable: true })
})

it('R14 #284 keeps refusing when the option travels through #289 readiness resolution', async () => {
  const runtime = ptyRuntime(null, { status: 'exited', tail: ['bye'] })
  // The resolver is the only readiness path the durable commit uses now. If it stopped
  // forwarding the option, a failed source would be committed as a finished one.
  await expect(
    resolveSessionOutcomeSourceReadiness(runtime, chain(), { successfulOnly: true })
  ).resolves.toMatchObject({ ready: false })
})

it('R3 #289 demotes a stored sourceReady on a definite not-ready observation', async () => {
  const stored = chain({ sourceReady: true, sourceVersion: 'v1' })
  // Definite: the source is running, so the stored receipt is replaced, not trusted.
  await expect(
    resolveSessionOutcomeSourceReadiness(
      ptyRuntime({ state: 'working' }, { status: 'running', tail: [] }),
      stored
    )
  ).resolves.toMatchObject({ ready: false })
  // Indefinite: contact is lost, so the stored receipt survives as #289 intended.
  const lost = {
    resolveTerminalPane: () => {
      throw new Error('gone')
    }
  } as unknown as OrcaRuntimeService
  await expect(resolveSessionOutcomeSourceReadiness(lost, stored)).resolves.toMatchObject({
    ready: true,
    unverifiable: true
  })
})

const turnHost = (turn: unknown, observe?: unknown) =>
  setStructuredAgentSessionHost({
    listSessionTabs: () => [{ sessionId: 'chat-1', workspaceId: 'wt', agent: 'claude' }],
    turnState: () => turn,
    ...(observe === undefined ? {} : { outcomeSource: { observe: () => observe } })
  } as never)

const structuredChain = () =>
  ({ sourcePaneKey: paneKey, worktreeId: 'wt', steps: [] }) as unknown as SessionChain

const noPty = () =>
  ({
    resolveTerminalPane: () => {
      throw new Error('no PTY')
    }
  }) as unknown as OrcaRuntimeService

it('R2 #289 refuses an interrupted, failed or unsettled structured turn', async () => {
  for (const outcome of ['interrupted', 'failed', 'unknown'] as const) {
    turnHost({ running: false, hasTurn: true, outcome, lastSequence: 3 })
    const observed = await observeSessionOutcomeSource(noPty(), structuredChain())
    expect(observed.ready).toBe(false)
    expect(observed.reason).toBeTruthy()
  }
})

it('R9 #283 refuses a journal turn with no confirmed admission receipt', () => {
  expect(
    observeStructuredAgentSessionOutcome({
      sessionId: 'chat-1',
      submissions: [{ clientMessageId: 'c1', dispatchState: 'accepted' }],
      items: []
    } as never)
  ).toMatchObject({ ready: false })
  expect(
    observeStructuredAgentSessionOutcome({ submissions: [], items: [] } as never)
  ).toMatchObject({ ready: false })
})

it('R9 #283 refuses while the source agent is waiting on an approval', () => {
  expect(
    observeStructuredAgentSessionOutcome({
      sessionId: 'chat-1',
      submissions: [{ clientMessageId: 'c1', dispatchState: 'accepted', providerItemId: 'p1' }],
      items: [{ body: { kind: 'approval', resolution: { state: 'pending' } } }]
    } as never)
  ).toMatchObject({ ready: false, reason: 'The source agent needs your input.' })
})

it('R17 combined: one reading may not pass a source the other reading refuses', async () => {
  const settled = {
    running: false,
    hasTurn: true,
    outcome: 'completed' as const,
    lastSequence: 7
  }
  // #289's reading says finished; #283's journal reading refuses. The refusal must win.
  turnHost(settled, {
    ready: false,
    reason: 'The latest source turn has no confirmed admission receipt.'
  })
  await expect(observeSessionOutcomeSource(noPty(), structuredChain())).resolves.toMatchObject({
    ready: false
  })
  // And the other way round.
  turnHost(
    { running: false, hasTurn: true, outcome: 'failed' as const, lastSequence: 7 },
    { ready: true, version: 'v' }
  )
  await expect(observeSessionOutcomeSource(noPty(), structuredChain())).resolves.toMatchObject({
    ready: false
  })
  // Both agreeing is the only way through.
  turnHost(settled, { ready: true, version: 'v' })
  await expect(observeSessionOutcomeSource(noPty(), structuredChain())).resolves.toMatchObject({
    ready: true
  })
})

it('R17 combined: a definite refusal is reported ahead of an unverifiable one', async () => {
  turnHost(
    { running: false, hasTurn: true, outcome: 'failed' as const, lastSequence: 7 },
    { ready: false, unverifiable: true, reason: 'Loss of contact.' }
  )
  const observed = await observeSessionOutcomeSource(noPty(), structuredChain())
  expect(observed.unverifiable).toBeFalsy()
  expect(observed.reason).toContain('failed')
})

it('R16 #291 grants no new side-by-side consent on an AI commit', () => {
  const outcomes = [{ id: 'a' }, { id: 'b' }] as never
  expect(sessionOutcomeParallelConsent({ source: 'user', outcomes }, undefined)).toEqual(['a', 'b'])
  expect(sessionOutcomeParallelConsent({ source: 'ai', outcomes }, undefined)).toEqual([])
  expect(
    sessionOutcomeParallelConsent({ source: 'ai', outcomes }, {
      outcomeSet: {},
      parallelOutcomeIds: ['a', 'z']
    } as never)
  ).toEqual(['a'])
})

it('the merged tree still reads both journal turn endings from one row', async () => {
  // Both #289's `outcome` and #283's `settlement` survive on the same lifecycle row; dropping
  // either field is what would silently disable one of the two readings above.
  const { AgentJournalItemBodySchema } = await import('../../shared/agent-session-journal-schemas')
  const parsed = AgentJournalItemBodySchema.safeParse({
    kind: 'status',
    text: '',
    turnLifecycle: {
      turnId: 't1',
      state: 'completed',
      outcome: 'interrupted',
      settlement: { providerItemId: 'p1', outcome: 'cancelled' }
    }
  })
  expect(parsed.success).toBe(true)
})
