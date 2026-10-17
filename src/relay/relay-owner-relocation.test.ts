import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  SESSION_RELOCATION_CODEX_CAPABILITY,
  type SessionHostRelocationProvider
} from '../shared/session-host-capabilities'
import { SessionHostClient } from '../shared/session-host-client'
import {
  fixtureOperationId,
  LEGACY_RELAY_PTY_CAPABILITIES
} from '../shared/session-host-wire-fixtures'
import { encodeClaudeProjectPath } from '../main/ai-vault/claude-project-dir-encoding'
import { sshSessionHostTransport } from '../main/session-host/session-host-client-transports'
import {
  remote,
  TEST_NOW,
  testHostRoot,
  type TestHostRoot
} from '../main/session-host/session-host-test-fixture'
import {
  PERSON_ON_STUDIO,
  STEWARD_ON_STUDIO,
  type TestComputer
} from '../main/session-manage/session-transfer-host-fixture'
import { sessionHostClientPort } from '../main/session-manage/session-transfer-host-port'
import { testComputer, testPort } from '../main/session-manage/session-transfer-port-fixture'
import { processGroupGone } from '../main/session-manage/session-transfer-process-group'
import { relocateConversation } from '../main/session-manage/session-transfer-relocate'
import { sessionHostRelocationChannel } from '../main/session-manage/session-transfer-relocate-channel'
import { memorySessionRelocationRecords } from '../main/session-manage/session-transfer-relocate-record'
import { configureRelocationSwitch } from '../main/session-manage/session-transfer-relocation-switch'
import type { MethodHandler, RequestContext } from './dispatcher'
import type { RelayPtyAgentEvidence } from './pty-agent-process-evidence'
import { adoptRelaySessions } from './relay-owner-adoption'
import { RELAY_DESTINATION_REFUSAL } from './relay-owner-relocation'
import { hookReport, relayTestHost, type RelayTestHost } from './relay-owner-test-host'
import { RelaySessionHostHandler } from './session-host-relay-handler'

// Why a terminal row is faked: `ps` shows no TTY for a test's process; its signal and exit are real.
const AGENT_STARTED_MS = 1_790_000_000_000
vi.mock('../main/pty/posix-pty-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPosixReceiverRowSync: (pid: number) =>
    agent?.pid === pid && !processGroupGone(pid)
      ? {
          pid,
          pgid: pid,
          tpgid: pid,
          tty: 'ttys009',
          startTimeMs: AGENT_STARTED_MS,
          stat: 'S+',
          command: 'claude'
        }
      : null
}))

const IDS = {
  claude: '5b1f0c1e-7d7c-4c0e-9a55-0f1f2e3d4c5b',
  codex: '01a0a697-11e7-7cc0-9e21-eb1844eb3128'
} as const
const POSIX = process.platform !== 'win32'

let root: TestHostRoot
let laptop: TestComputer
let disposeLaptop: () => void
let relay: RelayTestHost
let agent: ChildProcess | null
let minted = 60_000
let relays = 0

beforeEach(async () => {
  root = testHostRoot()
  const opened = await testComputer('Laptop')
  laptop = opened.computer
  disposeLaptop = opened.dispose
  agent = null
})
afterEach(async () => {
  agent?.kill('SIGKILL')
  await relay?.waits.flush().catch(() => {})
  disposeLaptop()
  root.dispose()
})

/** The agent's pane as the relay's process table shows it: a real process group while it runs. */
async function agentEvidence(ptyId: string): Promise<RelayPtyAgentEvidence> {
  const pid = agent?.pid
  const alive = pid !== undefined && !processGroupGone(pid)
  const proof = alive
    ? {
        ptyId,
        incarnationId: 'inc-1',
        rootPid: pid,
        pid,
        pgid: pid,
        startTimeMs: AGENT_STARTED_MS,
        agent: 'claude',
        via: 'command-line' as const
      }
    : null
  return {
    id: ptyId,
    incarnationId: 'inc-1',
    proof,
    tree: { kind: alive ? 'other' : 'agent-gone' }
  }
}

/** A provider-native transcript and a credential in the relay user's home. */
function writeTranscript(provider: SessionHostRelocationProvider, sessionId: string): string {
  const home = join(root.root, 'home', provider === 'claude' ? '.claude' : '.codex')
  const path =
    provider === 'claude'
      ? join(home, 'projects', encodeClaudeProjectPath('/srv/app'), `${sessionId}.jsonl`)
      : join(home, 'sessions', '2026', '09', '26', `rollout-2026-09-26T08-00-00-${sessionId}.jsonl`)
  const records =
    provider === 'claude'
      ? Array.from({ length: 400 }, (_, n) => ({
          type: n % 2 ? 'assistant' : 'user',
          n,
          sessionId
        }))
      : [
          { type: 'session_meta', payload: { id: sessionId } },
          ...Array.from({ length: 400 }, (_, n) => ({ type: 'response_item', n }))
        ]
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  writeFileSync(join(home, provider === 'claude' ? '.credentials.json' : 'auth.json'), '{}')
  return path
}

/** An adopted, idle conversation on the relay whose agent is a real running process group. */
async function relayConversation(
  provider: SessionHostRelocationProvider,
  options: { relocation: boolean } = { relocation: true }
) {
  relay = relayTestHost({
    root: join(root.root, `relay-${(relays += 1)}`),
    ...(options.relocation
      ? { relocation: { agentEvidence, homeDir: join(root.root, 'home') } }
      : {})
  })
  const transcript = writeTranscript(provider, IDS[provider])
  if (POSIX) {
    agent = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  }
  relay.foreground.current = provider
  relay.report(
    hookReport('done', {
      providerSession: { key: 'session_id', id: IDS[provider] },
      payload: { state: 'done', prompt: '', agentType: provider, lastAssistantMessage: 'Done.' }
    })
  )
  const service = await relay.process.service()
  await adoptRelaySessions({ store: service.store, facts: relay.facts, turns: relay.turns })
  const registration = Object.values(service.store.snapshot()!.conversations)[0]!
  expect(registration).toMatchObject({ adopted: true, provider: { sessionId: IDS[provider] } })
  return { service, registration, transcript }
}

/** A Mac reaching the relay as it does over SSH: the relay's own handler, gate and negotiation. */
async function relayPort() {
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
        ? { ...LEGACY_RELAY_PTY_CAPABILITIES, ...handler.ptyCapabilities() }
        : await handlers.get(method)!(params ?? {}, context)
  }
  const client = new SessionHostClient(
    sshSessionHostTransport({
      mux: () => mux,
      connection: () => 'conn-1',
      clientHostId: `host_${'c'.repeat(32)}`
    })
  )
  const { identity } = await relay.process.service()
  return sessionHostClientPort(client, { hostId: identity.hostId, label: 'ssh:box-1' })
}

async function move(
  source: Awaited<ReturnType<typeof relayPort>> | ReturnType<typeof testPort>,
  destination: Awaited<ReturnType<typeof relayPort>> | ReturnType<typeof testPort>,
  conversationId: string,
  origin = PERSON_ON_STUDIO
) {
  return await relocateConversation(
    {
      source,
      destination,
      channel: sessionHostRelocationChannel({ attempts: 3, sleep: async () => {} }),
      records: memorySessionRelocationRecords(),
      relocationEnabled: () => true,
      mintOperationId: () => fixtureOperationId(minted++),
      now: () => TEST_NOW,
      // Why real time: the relay's freeze waits for the agent's group to be gone.
      step: { waitMs: 20_000, pollMs: 25 }
    },
    {
      conversationId,
      origin,
      workspace: { kind: 'folder', path: '/work/Laptop' },
      providerVersion: 'unknown',
      dryRun: false
    }
  )
}

const relocateOps = (store: {
  snapshot(): { operations: Record<string, { action: string }> } | null
}) =>
  Object.values(store.snapshot()?.operations ?? {}).filter((op) =>
    op.action.startsWith('relocate.')
  )

describe('moving a conversation away from an SSH relay (package B3)', () => {
  it.skipIf(!POSIX).each(['claude', 'codex'] as const)(
    'moves a %s conversation to a Mac with the identical id, its agent stopped with proof',
    async (provider) => {
      const { service, registration, transcript } = await relayConversation(provider)
      const pid = agent!.pid!
      const result = await move(await relayPort(), testPort(laptop), registration.conversationId)
      expect([result.outcome, result.ownerEpoch, result.provider]).toEqual([
        'relocated',
        2,
        provider
      ])
      expect(laptop.launched.map((launch) => launch.sessionId)).toEqual([IDS[provider]])
      expect(readFileSync(laptop.launched[0]!.transcriptPath, 'utf8')).toBe(
        readFileSync(transcript, 'utf8')
      )
      expect(processGroupGone(pid)).toBe(true)
      // Why: freezing signals the agent's own group; it never types into the terminal.
      expect(relay.written).toEqual([])
      expect(service.store.snapshot()!.conversations[registration.conversationId]!.owned).toBe(
        false
      )
      expect(
        existsSync(
          join(
            laptop.providerRoot(provider),
            provider === 'claude' ? '.credentials.json' : 'auth.json'
          )
        )
      ).toBe(false)
    },
    30_000
  )

  it('advertises relocation and bundle calls only while the handler is installed and relocation is on', async () => {
    await relayConversation('claude')
    const moves = [
      SESSION_RELOCATION_CLAUDE_CAPABILITY,
      SESSION_RELOCATION_CODEX_CAPABILITY,
      SESSION_RELOCATION_BUNDLE_CAPABILITY
    ]
    expect(relay.process.advertisement()!.capabilities).toEqual(expect.arrayContaining(moves))
    const restore = configureRelocationSwitch({ environment: { OMNI_RELOCATION_DISABLED: '1' } })
    try {
      expect(relay.process.advertisement()!.capabilities).not.toEqual(
        expect.arrayContaining([SESSION_RELOCATION_BUNDLE_CAPABILITY])
      )
    } finally {
      restore()
    }
    await relayConversation('claude', { relocation: false })
    for (const capability of moves) {
      expect(relay.process.advertisement()!.capabilities).not.toContain(capability)
    }
  })

  it('an older relay (no relocation handler) is still refused by the preflight, before anything freezes', async () => {
    const { service, registration } = await relayConversation('claude', { relocation: false })
    const result = await move(await relayPort(), testPort(laptop), registration.conversationId)
    expect([result.outcome, result.code]).toEqual(['refused', 'unsupported-capability'])
    expect(relocateOps(service.store)).toEqual([])
    expect(laptop.launched).toEqual([])
  })

  it('an automatic caller only gets a proposal, and the relay refuses it any move step', async () => {
    const { service, registration } = await relayConversation('claude')
    const proposed = await move(
      await relayPort(),
      testPort(laptop),
      registration.conversationId,
      STEWARD_ON_STUDIO
    )
    expect(proposed.outcome).toBe('proposed')
    expect(relocateOps(service.store)).toEqual([])
    const refused = await relay.executor.prepare({
      request: {
        operationId: fixtureOperationId(59_000),
        conversationId: registration.conversationId,
        expectedOwnerEpoch: 1,
        action: 'relocate.freeze-source',
        payload: {
          relocation: fixtureOperationId(59_001),
          provider: 'claude',
          destination: { hostId: laptop.service.identity.hostId }
        }
      },
      authority: remote('mac-b', STEWARD_ON_STUDIO),
      operation: {} as never,
      registration,
      marker: ''
    } as never)
    expect(refused).toMatchObject({ kind: 'refuse', refusal: { code: 'unattended-restricted' } })
    if (agent) {
      expect(processGroupGone(agent.pid!)).toBe(false)
    }
  })

  it('refuses to be the destination before the source freezes', async () => {
    await relayConversation('claude')
    const conversation = await laptop.conversation('claude', IDS.claude, 12)
    const result = await move(testPort(laptop), await relayPort(), conversation.conversationId)
    expect(result.outcome).toBe('refused')
    expect(result.summary).toContain(RELAY_DESTINATION_REFUSAL.message.split(':')[0])
    expect(laptop.frozen.size).toBe(0)
    expect(laptop.service.store.snapshot()!.conversations[conversation.conversationId]!.owned).toBe(
      true
    )
  })
})
