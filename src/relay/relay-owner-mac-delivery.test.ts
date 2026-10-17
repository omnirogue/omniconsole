import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverToConversation } from '../main/runtime/conversation-delivery'
import type { ConversationSource } from '../shared/conversation-source'
import { SessionHostClient } from '../shared/session-host-client'
import {
  fixtureOperationId,
  LEGACY_RELAY_PTY_CAPABILITIES
} from '../shared/session-host-wire-fixtures'
import { sshSessionHostTransport } from '../main/session-host/session-host-client-transports'
import { SessionHostDeliveryRefusedError } from '../main/session-host/session-host-delivery-admission'
import {
  MAC_B,
  remote,
  testHostRoot,
  type TestHostRoot
} from '../main/session-host/session-host-test-fixture'
import { deliverThroughSshSessionHost } from '../main/session-host-owner/ssh-session-host-delivery'
import type { MethodHandler, RequestContext } from './dispatcher'
import { adoptRelaySessions } from './relay-owner-adoption'
import {
  hookReport,
  RELAY_PANE,
  RELAY_WORKTREE,
  relayTestHost,
  type RelayTestHost
} from './relay-owner-test-host'
import { RelaySessionHostHandler } from './session-host-relay-handler'

const routedClient = vi.hoisted(() => ({ current: null as SessionHostClient | null }))
vi.mock('../main/session-host-owner/ssh-session-host-clients', () => ({
  sshSessionHostClientFor: () => routedClient.current
}))

const SOURCE: ConversationSource = { worktreeId: RELAY_WORKTREE, paneKey: RELAY_PANE, kind: 'pty' }
const MAC_HOST_ID = `host_${'c'.repeat(32)}`
const sshPane = { resolveTerminalPane: () => ({ executionHostId: 'ssh:box-1' }) }

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

/** This Mac's connection to the relay: the relay's real session host handler behind a mux. */
function macClient(options: { advertise: boolean } = { advertise: true }) {
  const handlers = new Map<string, MethodHandler>()
  const handler = new RelaySessionHostHandler(
    {
      onRequest: (method, run) => handlers.set(method, run),
      onClientDetached: () => () => {},
      isPrimaryClient: (clientId) => clientId === 1
    },
    relay.process
  )
  const context: RequestContext = { clientId: 1, isStale: () => false }
  const mux = {
    request: async (method: string, params?: Record<string, unknown>) =>
      method === 'pty.getCapabilities'
        ? {
            ...LEGACY_RELAY_PTY_CAPABILITIES,
            ...(options.advertise ? handler.ptyCapabilities() : {})
          }
        : await handlers.get(method)!(params ?? {}, context)
  }
  return {
    client: new SessionHostClient(
      sshSessionHostTransport({
        mux: () => mux,
        connection: () => 'conn-1',
        clientHostId: MAC_HOST_ID
      })
    ),
    handlers,
    context
  }
}

async function adopt() {
  const service = await relay.process.service()
  await adoptRelaySessions({ store: service.store, facts: relay.facts, turns: relay.turns })
  return service
}

const deliver = (
  client: SessionHostClient,
  extra: { writer?: string; unattended?: boolean } = {}
) =>
  deliverThroughSshSessionHost({
    runtime: sshPane,
    source: SOURCE,
    text: 'Run the parser tests.',
    operationId: fixtureOperationId(40),
    writer: extra.writer ?? 'prompt-queue',
    unattended: extra.unattended ?? false,
    computer: 'Studio',
    clientFor: () => client
  })

describe('this Mac’s own writers on an SSH conversation the relay adopted', () => {
  it('deliver through the relay’s admission, never as raw PTY bytes from the Mac', async () => {
    await adopt()
    const { client } = macClient()
    const delivered = await deliver(client)
    expect(delivered).toMatchObject({ door: 'pty' })
    // The relay itself wrote the queued text verbatim (no marker added), then Enter.
    expect(relay.written.map((write) => write.data)).toEqual([
      expect.stringContaining('Run the parser tests.'),
      '\r'
    ])
    expect(relay.written[0]!.data).not.toContain('[from')
  })

  it('reach the relay from the send door itself: the Mac writes no PTY bytes', async () => {
    await adopt()
    routedClient.current = macClient().client
    const sendTerminalAgentPrompt = vi.fn()
    const delivered = await deliverToConversation(
      { ...sshPane, sendTerminalAgentPrompt } as never,
      SOURCE,
      'Run the parser tests.',
      { operationId: fixtureOperationId(44), hostAdmission: { writer: 'prompt-queue' } }
    )
    expect(delivered.door).toBe('pty')
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(relay.written).toHaveLength(2)
    routedClient.current = null
  })

  it('a remote continue and this Mac’s Keep going on one turn: exactly one admission', async () => {
    const service = await adopt()
    const [registration] = Object.values(service.store.snapshot()!.conversations)
    const turn = relay.turns.revision(RELAY_PANE)
    const continued = await service.execute(
      {
        operationId: fixtureOperationId(41),
        conversationId: registration!.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: turn,
        action: 'continue',
        payload: { answer: { kind: 'prompt', text: 'Summarize what changed.' } }
      },
      remote('mac-b', MAC_B)
    )
    expect(continued).toMatchObject({ operation: { state: 'completed' } })
    const { client } = macClient()
    await expect(
      deliver(client, { writer: 'keep-going', unattended: true })
    ).rejects.toBeInstanceOf(SessionHostDeliveryRefusedError)
    expect(relay.written).toHaveLength(2)
  })

  it('and the other way round: this Mac’s Keep going first, the remote continue refused', async () => {
    const service = await adopt()
    const [registration] = Object.values(service.store.snapshot()!.conversations)
    const turn = relay.turns.revision(RELAY_PANE)
    const { client } = macClient()
    expect(await deliver(client, { writer: 'keep-going', unattended: true })).toMatchObject({
      door: 'pty'
    })
    const continued = await service.execute(
      {
        operationId: fixtureOperationId(45),
        conversationId: registration!.conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: turn,
        action: 'continue',
        payload: { answer: { kind: 'prompt', text: 'Summarize what changed.' } }
      },
      remote('mac-b', MAC_B)
    )
    expect(continued).toMatchObject({ operation: { refusal: { code: 'turn-reserved' } } })
    expect(relay.written).toHaveLength(2)
  })

  it('an automatic writer’s text still meets the hard stops on the relay', async () => {
    await adopt()
    const { client } = macClient()
    const stopped = deliverThroughSshSessionHost({
      runtime: sshPane,
      source: SOURCE,
      text: 'helm upgrade api ./chart',
      operationId: fixtureOperationId(42),
      writer: 'keep-going',
      unattended: true,
      computer: 'Studio',
      clientFor: () => client
    })
    await expect(stopped).rejects.toMatchObject({ refusal: { code: 'hard-stop' } })
    expect(relay.written).toHaveLength(0)
  })
})

describe('where today’s path still applies', () => {
  it('a relay that does not advertise delivery (an older one)', async () => {
    await adopt()
    const { client } = macClient({ advertise: false })
    expect(await deliver(client)).toBeNull()
    expect(relay.written).toHaveLength(0)
  })

  it('a conversation the relay did not adopt (its agent not proven in the foreground)', async () => {
    relay.foreground.current = 'bash'
    const service = await adopt()
    expect(Object.values(service.store.snapshot()!.conversations)[0]).toMatchObject({
      adopted: false
    })
    const { client } = macClient()
    expect(await deliver(client)).toBeNull()
    expect(relay.written).toHaveLength(0)
  })

  it('a pane this Mac runs itself, without asking any relay', async () => {
    const clientFor = vi.fn()
    const local = await deliverThroughSshSessionHost({
      runtime: { resolveTerminalPane: () => ({ executionHostId: 'local' }) },
      source: SOURCE,
      text: 'x',
      operationId: fixtureOperationId(43),
      writer: 'prompt-queue',
      unattended: false,
      computer: 'Studio',
      clientFor
    })
    expect(local).toBeNull()
    expect(clientFor).not.toHaveBeenCalled()
  })
})
