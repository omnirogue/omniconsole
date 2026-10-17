import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionHostClientTransport } from '../../shared/session-host-client'
import { SessionHostClient } from '../../shared/session-host-client'
import { SessionHostOwnerDirectory } from '../../shared/session-host-owner-directory'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import {
  MAC_A,
  MAC_B,
  testHostRoot,
  type TestHostRoot
} from '../session-host/session-host-test-fixture'
import type { SessionHostReceivedObservation } from '../../shared/session-host-reply-schema'
import {
  findRemoteObservation,
  runRemoteSessionAction,
  type RemoteSessionActionInput
} from './remote-session-action'
import {
  pairedMacTransport,
  REMOTE_TEST_PANE as PANE,
  remoteTestRuntime,
  resetRemoteTestRuntime,
  UNREACHABLE_HOST_TRANSPORT
} from './remote-session-test-fixture'

let host: TestHostRoot
beforeEach(() => {
  host = testHostRoot()
})
afterEach(() => {
  resetRemoteTestRuntime()
  host.dispose()
})

const pairedMac = (device: string, calls: string[] = [], legacy = false) =>
  pairedMacTransport(device, { calls, legacy })
const pairedRuntime = () => remoteTestRuntime(host.root)

function continueInput(
  origin = MAC_A,
  extra: Partial<RemoteSessionActionInput<'continue'>> = {}
): RemoteSessionActionInput<'continue'> {
  return {
    connection: 'runtime:studio',
    target: { paneKey: PANE, tabId: null },
    action: 'continue',
    payload: { answer: { kind: 'prompt', text: 'Carry on with the release notes.' } },
    origin,
    dryRun: false,
    ...extra
  }
}

function runner(transport: SessionHostClientTransport, n: number) {
  return {
    client: new SessionHostClient(transport),
    directory: new SessionHostOwnerDirectory(),
    newOperationId: () => fixtureOperationId(n)
  }
}

describe('a control on a session another computer runs', () => {
  it('never substitutes another split when the selected owner pane has disappeared', async () => {
    const { executor } = await pairedRuntime()
    const outcome = await runRemoteSessionAction(
      runner(pairedMac('studio'), 1),
      continueInput(MAC_A, {
        target: { paneKey: `${PANE.split(':')[0]}:closed-leaf`, tabId: PANE.split(':')[0]! }
      })
    )
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'unknown-conversation' } })
    expect(executor.dispatched).toHaveLength(0)
  })

  it('refuses a selected pane now occupied by a different provider conversation', async () => {
    const { executor } = await pairedRuntime()
    const outcome = await runRemoteSessionAction(
      runner(pairedMac('studio'), 1),
      continueInput(MAC_A, {
        target: {
          paneKey: PANE,
          tabId: null,
          provider: { agent: 'claude', sessionId: 'previous-conversation' }
        }
      })
    )
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'unknown-conversation' } })
    expect(executor.dispatched).toHaveLength(0)
  })

  it('two Macs continuing the same idle session: the host delivers once', async () => {
    const { executor } = await pairedRuntime()
    const [studio, laptop] = await Promise.all([
      runRemoteSessionAction(runner(pairedMac('studio'), 1), continueInput(MAC_A)),
      runRemoteSessionAction(runner(pairedMac('laptop'), 2), continueInput(MAC_B))
    ])
    expect([studio.kind, laptop.kind].sort()).toEqual(['completed', 'refused'])
    const lost = [studio, laptop].find((outcome) => outcome.kind === 'refused')!
    expect(lost).toMatchObject({
      refusal: { code: 'turn-reserved' },
      retry: 'new-operation-after-observe'
    })
    expect(executor.dispatched).toHaveLength(1)
  })

  it('an older host is refused before anything is sent, in plain words', async () => {
    await pairedRuntime()
    const calls: string[] = []
    const outcome = await runRemoteSessionAction(
      runner(pairedMac('studio', calls, true), 1),
      continueInput()
    )
    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: { code: 'unsupported-capability' },
      verdict: 'unverifiable'
    })
    expect(calls).toEqual(['status.get'])
  })

  it('an unreachable host reads unverifiable; nothing is sent and nothing is done here', async () => {
    const { executor } = await pairedRuntime()
    const outcome = await runRemoteSessionAction(
      runner(UNREACHABLE_HOST_TRANSPORT, 1),
      continueInput()
    )
    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: { code: 'host-unreachable' },
      retry: 'repeat-same-operation',
      verdict: 'unverifiable'
    })
    expect(executor.dispatched).toHaveLength(0)
  })

  it('a session the host does not list is refused without an execute', async () => {
    await pairedRuntime()
    const calls: string[] = []
    const outcome = await runRemoteSessionAction(
      runner(pairedMac('studio', calls), 1),
      continueInput(MAC_A, { target: { paneKey: 'tab-9:elsewhere', tabId: null } })
    )
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'unknown-conversation' } })
    expect(calls).not.toContain('sessionHost.execute')
  })

  it('finds the conversation by its provider id when this Mac has no pane for it', async () => {
    const { executor } = await pairedRuntime()
    const outcome = await runRemoteSessionAction(
      runner(pairedMac('studio'), 1),
      continueInput(MAC_A, {
        target: {
          paneKey: null,
          tabId: null,
          provider: { agent: 'claude', sessionId: 'claude-session-1' }
        }
      })
    )
    expect(outcome.kind).toBe('completed')
    expect(executor.dispatched).toHaveLength(1)
  })

  it('a dry run observes and checks but sends nothing', async () => {
    const { executor } = await pairedRuntime()
    const calls: string[] = []
    const outcome = await runRemoteSessionAction(
      runner(pairedMac('studio', calls), 1),
      continueInput(MAC_A, { dryRun: true })
    )
    expect(outcome).toMatchObject({ kind: 'would', verdict: 'live' })
    expect(calls).not.toContain('sessionHost.execute')
    expect(executor.dispatched).toHaveLength(0)
  })

  it('a host refusal comes back in the host’s own words (a relay that cannot answer, say)', async () => {
    const { executor } = await pairedRuntime()
    executor.prepareRefusal = {
      kind: 'refuse',
      refusal: {
        code: 'unsupported-capability',
        message: 'An SSH relay cannot answer permission prompts yet. Nothing was sent.'
      }
    }
    const outcome = await runRemoteSessionAction(runner(pairedMac('studio'), 1), continueInput())
    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: { message: 'An SSH relay cannot answer permission prompts yet. Nothing was sent.' }
    })
    expect(executor.dispatched).toHaveLength(0)
  })
})

describe('a lost reply', () => {
  it('is settled by asking the host what it recorded; the prompt is never sent twice', async () => {
    const { executor } = await pairedRuntime()
    const inner = pairedMac('studio')
    const lossy: SessionHostClientTransport = {
      ...inner,
      call: async (method, params) => {
        const answer = await inner.call(method, params)
        // Why after the host answered: bytes moved, the reply did not come back.
        return method === 'sessionHost.execute'
          ? { ok: false, error: new Error('socket closed') }
          : answer
      }
    }
    const outcome = await runRemoteSessionAction(runner(lossy, 1), continueInput())
    expect(outcome.kind).toBe('completed')
    expect(executor.dispatched).toEqual([fixtureOperationId(1)])
  })

  it('is sent once more, identically, only when the reachable host never recorded it', async () => {
    const { executor } = await pairedRuntime()
    const inner = pairedMac('studio')
    let dropped = 0
    const dropsFirst: SessionHostClientTransport = {
      ...inner,
      call: async (method, params) => {
        if (method === 'sessionHost.execute' && dropped === 0) {
          dropped += 1
          return { ok: false, error: new Error('socket closed before sending') }
        }
        return await inner.call(method, params)
      }
    }
    const outcome = await runRemoteSessionAction(runner(dropsFirst, 1), continueInput())
    expect(outcome.kind).toBe('completed')
    expect(executor.dispatched).toEqual([fixtureOperationId(1)])
  })
})

describe('choosing the registration a pane names', () => {
  function registered(
    sessionId: string,
    extra: Partial<SessionHostReceivedObservation> = {}
  ): SessionHostReceivedObservation {
    return {
      conversationId: `conv-${sessionId}`,
      ownerEpoch: 1,
      turnRevision: null,
      verdict: 'unverifiable',
      admission: 'open',
      provider: { agent: 'codex', sessionId },
      ref: {
        hostId: 'host-studio',
        conversationId: `conv-${sessionId}`,
        paneKey: PANE,
        tabId: null,
        worktreePath: null
      },
      ...extra
    } as SessionHostReceivedObservation
  }
  // The live journal order: the pane's earlier conversation is listed before the current one.
  const earlier = registered('earlier-conversation')
  const current = registered('current-conversation', { verdict: 'live', entry: { state: 'idle' } })

  it('takes the provider conversation the person selected, not the first one on the pane', () => {
    expect(
      findRemoteObservation([earlier, current], {
        paneKey: PANE,
        tabId: null,
        provider: { agent: 'codex', sessionId: 'current-conversation' }
      })
    ).toBe(current)
  })

  it('without a provider id, takes the one the host sees on that pane now', () => {
    expect(findRemoteObservation([earlier, current], { paneKey: PANE, tabId: null })).toBe(current)
  })

  it('refuses when the pane holds two conversations the host sees and nothing tells them apart', () => {
    const other = registered('other-conversation', { entry: { state: 'idle' } })
    expect(findRemoteObservation([other, current], { paneKey: PANE, tabId: null })).toBeNull()
  })
})
