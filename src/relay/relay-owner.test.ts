import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_SUBMIT } from '../shared/agent-prompt-injection'
import { sessionHostPromptMarker } from '../shared/session-host-authority'
import { fixtureOperationId } from '../shared/session-host-wire-fixtures'
import {
  continueRequest,
  MAC_A,
  MAC_B,
  remote,
  testHostRoot,
  withoutOrigin,
  type TestHostRoot
} from '../main/session-host/session-host-test-fixture'
import { configureSessionHostSwitches } from '../main/session-host-owner/session-host-switches'
import { adoptRelaySessions, reconcileRelayDeliveries } from './relay-owner-adoption'
import { relayOwnerSessions } from './relay-owner-sessions'
import {
  hookReport,
  RELAY_PANE,
  RELAY_SESSION,
  relayTestHost,
  type RelayTestHost
} from './relay-owner-test-host'

let root: TestHostRoot
let relay: RelayTestHost

beforeEach(() => {
  root = testHostRoot()
  relay = relayTestHost({ root: root.root })
  relay.report(hookReport('done', { providerPromptId: 'prompt-1' }))
})
afterEach(async () => {
  await relay.waits.flush().catch(() => {})
  root.dispose()
})

async function adopted() {
  const service = await relay.process.service()
  const facts = relay.facts
  await adoptRelaySessions({ store: service.store, facts, turns: relay.turns })
  const [registration] = Object.values(service.store.snapshot()!.conversations)
  return { service, registration: registration! }
}

const prompt = (n: number, conversationId: string, turn: string | null) =>
  continueRequest(n, conversationId, {
    expectedTurnRevision: turn,
    payload: { answer: { kind: 'prompt', text: `Summarize what changed (${n}).` } }
  })

describe('an SSH relay carries out another computer’s controls itself', () => {
  it('adopts a pane whose agent holds the terminal after a finished turn', async () => {
    const { registration } = await adopted()
    expect(registration).toMatchObject({
      adopted: true,
      provider: { agent: 'claude', sessionId: RELAY_SESSION },
      binding: { paneKey: RELAY_PANE, kind: 'pty' }
    })
  })

  it('continues with the other computer’s marker: paste, then Enter, with no Mac attached', async () => {
    const { service, registration } = await adopted()
    const turn = relay.turns.revision(RELAY_PANE)
    const result = await service.execute(
      withoutOrigin(prompt(1, registration.conversationId, turn)),
      remote('mac-b', MAC_B)
    )
    expect(result).toMatchObject({ operation: { state: 'completed' } })
    const [paste, enter] = relay.written
    expect(paste!.data).toContain(sessionHostPromptMarker(remote('mac-b', MAC_B)))
    expect(paste!.data).toContain('Summarize what changed (1).')
    expect(enter!.data).toBe(AGENT_PROMPT_SUBMIT)
  })

  it('two Macs with different ids for one idle turn: one continuation', async () => {
    const { service, registration } = await adopted()
    const turn = relay.turns.revision(RELAY_PANE)
    const first = await service.execute(
      withoutOrigin(prompt(1, registration.conversationId, turn)),
      remote('mac-a', MAC_A)
    )
    const second = await service.execute(
      withoutOrigin(prompt(2, registration.conversationId, turn)),
      remote('mac-b', MAC_B)
    )
    expect(first).toMatchObject({ operation: { state: 'completed' } })
    expect(second).toMatchObject({ operation: { refusal: { code: 'turn-reserved' } } })
    expect(relay.written).toHaveLength(2)
  })

  it('refuses before anything is written: a shell in the foreground, a busy agent, a hard stop', async () => {
    const { service, registration } = await adopted()
    const turn = relay.turns.revision(RELAY_PANE)
    relay.foreground.current = 'bash'
    const shell = await service.execute(
      withoutOrigin(prompt(1, registration.conversationId, turn)),
      remote('mac-b', MAC_B)
    )
    expect(shell).toMatchObject({ operation: { state: 'refused' } })
    relay.foreground.current = 'claude'
    const stop = await service.execute(
      withoutOrigin(
        continueRequest(2, registration.conversationId, {
          expectedTurnRevision: turn,
          payload: { answer: { kind: 'prompt', text: 'helm upgrade api ./chart' } }
        })
      ),
      remote('mac-b', MAC_B)
    )
    expect(stop).toMatchObject({ operation: { refusal: { code: 'hard-stop' } } })
    relay.report(hookReport('working'))
    const busy = await service.execute(
      withoutOrigin(prompt(3, registration.conversationId, turn)),
      remote('mac-b', MAC_B)
    )
    expect(busy).toMatchObject({ operation: { state: 'refused' } })
    expect(relay.written).toHaveLength(0)
  })

  it('an automatic caller never prompts or stops a session on a relay', async () => {
    const { service, registration } = await adopted()
    const steward = {
      computer: 'Studio',
      requester: { kind: 'cli' as const, unattended: { source: 'rules' as const } }
    }
    const nudge = await service.execute(
      withoutOrigin(prompt(1, registration.conversationId, relay.turns.revision(RELAY_PANE))),
      remote('mac-a', steward)
    )
    expect(nudge).toMatchObject({ operation: { refusal: { code: 'unattended-restricted' } } })
    const stop = await service.execute(
      {
        operationId: fixtureOperationId(2),
        conversationId: registration.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: null,
        action: 'stop',
        payload: {}
      },
      remote('mac-a', steward)
    )
    expect(stop).toMatchObject({ operation: { refusal: { code: 'unattended-restricted' } } })
    expect(relay.written).toHaveLength(0)
  })

  it('interrupts a working agent on stop; answering stays with a Mac that shows the question', async () => {
    const { service, registration } = await adopted()
    relay.report(hookReport('working'))
    const stopped = await service.execute(
      {
        operationId: fixtureOperationId(1),
        conversationId: registration.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: null,
        action: 'stop',
        payload: {}
      },
      remote('mac-b', MAC_B)
    )
    expect(stopped).toMatchObject({ operation: { state: 'completed' } })
    expect(relay.written).toEqual([{ ptyId: 'pty-9', data: '\x03' }])
    relay.report(hookReport('done', { providerPromptId: 'prompt-2' }))
    const answer = await service.execute(
      {
        operationId: fixtureOperationId(2),
        conversationId: registration.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: relay.turns.revision(RELAY_PANE),
        action: 'answer',
        payload: { expect: 'a'.repeat(64), answer: { kind: 'allow' } }
      },
      remote('mac-b', MAC_B)
    )
    expect(answer).toMatchObject({
      operation: { state: 'refused', refusal: { code: 'not-eligible' } }
    })
  })
})

describe('a question on a relay', () => {
  it('is answered by the reply the agent’s next finished turn carries', async () => {
    const { service, registration } = await adopted()
    const pending = service.execute(
      {
        operationId: fixtureOperationId(4),
        conversationId: registration.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: relay.turns.revision(RELAY_PANE),
        action: 'ask',
        payload: { question: 'Which tests still fail?' }
      },
      remote('mac-b', MAC_B)
    )
    await vi.waitFor(() => expect(relay.written).toHaveLength(2))
    expect(relay.written[0]!.data).toContain('Which tests still fail?')
    relay.report(
      hookReport('done', {
        providerPromptId: 'prompt-q',
        payload: { state: 'done', prompt: '', agentType: 'claude', lastAssistantMessage: 'None.' }
      })
    )
    expect(await pending).toMatchObject({
      operation: { state: 'completed', result: { outcome: 'answered', reply: 'None.' } }
    })
  })
})

describe('what a relay reports and advertises', () => {
  it('lives, exits and loses panes by its own evidence, never by silence', async () => {
    expect(relayOwnerSessions(relay.facts, relay.turns)[0]).toMatchObject({
      verdict: 'live',
      state: 'idle'
    })
    const { registration } = await adopted()
    relay.panes.splice(0)
    const gone = await relay.executor.observe([registration])
    expect(gone.get(registration.conversationId)).toMatchObject({ verdict: 'unverifiable' })
    relay.exited.set(RELAY_PANE, 5)
    const exited = await relay.executor.observe([registration])
    expect(exited.get(registration.conversationId)).toMatchObject({ verdict: 'exited' })
  })

  it('reports a finished Codex turn carrying an async question as waiting on the person', () => {
    const asyncAsk = JSON.stringify({
      delivery: 'async',
      asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [] }]
    })
    relay.report(
      hookReport('done', {
        payload: { state: 'done', prompt: '', agentType: 'codex', interactivePrompt: asyncAsk }
      })
    )
    expect(relayOwnerSessions(relay.facts, relay.turns)[0]).toMatchObject({ state: 'awaiting-user' })
  })

  it('reports a working agent silent for 10 minutes as stalled, and changes nothing', async () => {
    const { registration } = await adopted()
    relay.report(hookReport('working'))
    relay.clock.now += 11 * 60_000
    const observed = await relay.executor.observe([registration])
    expect(observed.get(registration.conversationId)?.entry).toMatchObject({
      state: 'working',
      stalled: { reason: 'Working without a report for 10 minutes.' }
    })
    expect(relay.written).toHaveLength(0)
  })

  it('advertises owner control, waits, delivery and host stats, organization never, and nothing when switched off', () => {
    expect(relay.executor.capabilities()).toEqual([
      'session-control.owner.v1',
      'session-waits.remote.v1',
      'session-control.delivery.v1',
      'session-control.host-stats.v1'
    ])
    const restore = configureSessionHostSwitches({
      environment: { OMNI_SESSION_HOST_DISABLED: '1' }
    })
    expect(relay.executor.capabilities()).toEqual([])
    restore()
  })
})

describe('restarts and waits on a relay', () => {
  it('settles a delivery a dead relay left unknown once the conversation takes a new turn', async () => {
    const { service, registration } = await adopted()
    await service.store.mutate(async (journal) => {
      const operationId = fixtureOperationId(9)
      journal.operations[operationId] = {
        operationId,
        conversationId: registration.conversationId,
        action: 'continue',
        state: 'unconfirmed',
        fingerprint: 'sha256:x',
        host: service.identity,
        ownerEpoch: 1,
        turnRevision: relay.turns.revision(RELAY_PANE),
        kind: 'execute',
        holder: 'remote:mac-b',
        controller: 'relay-0',
        audit: { authority: 'remote' }
      }
      return { value: null, changed: true }
    })
    await reconcileRelayDeliveries({ store: service.store, turns: relay.turns })
    expect(service.store.snapshot()!.operations[fixtureOperationId(9)]!.state).toBe('unconfirmed')
    relay.report(hookReport('done', { providerPromptId: 'prompt-2' }))
    await reconcileRelayDeliveries({ store: service.store, turns: relay.turns })
    expect(service.store.snapshot()!.operations[fixtureOperationId(9)]!.state).toBe('completed')
  })

  it('a wait on a relay session is met only by its next finished turn', async () => {
    const { service, registration } = await adopted()
    const registered = await service.execute(
      {
        operationId: fixtureOperationId(3),
        conversationId: registration.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: null,
        action: 'wait.register',
        payload: {
          waiter: { hostId: `host_${'a'.repeat(32)}`, conversationId: `conv_${'b'.repeat(32)}` },
          match: 'result'
        }
      },
      remote('mac-b', MAC_B)
    )
    expect(registered).toMatchObject({ operation: { state: 'completed' } })
    const status = { registration: fixtureOperationId(3), dependency: registration.conversationId }
    expect(await relay.executor.waitStatus(status)).toMatchObject({
      receipt: { state: 'registered' }
    })
    relay.clock.now += 1_000
    relay.report(hookReport('done', { providerPromptId: 'prompt-3' }))
    expect(await relay.executor.waitStatus(status)).toMatchObject({
      receipt: { state: 'satisfied', satisfiedBy: { ownerEpoch: 1 } }
    })
  })
})
