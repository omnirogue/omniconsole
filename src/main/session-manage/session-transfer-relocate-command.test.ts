import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CLIENT_CAPABILITIES,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  readClientSessionHostDeclaration
} from '../../shared/session-host-capabilities'
import {
  SessionHostClient,
  type SessionHostClientTransport
} from '../../shared/session-host-client'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { PreparedSessionAction } from '../runtime/rpc/methods/session-manage-support'
import { advertisableSessionHostCapabilities } from '../session-host/session-host-executor'
import { handleSessionHostRemoteCall } from '../session-host/session-host-remote-gate'
import type { TestComputer } from './session-transfer-host-fixture'
import { testComputer } from './session-transfer-port-fixture'

const wiring = vi.hoisted(() => ({
  local: null as null | {
    service: () => Promise<unknown>
    serviceIfPresent: () => Promise<unknown>
  },
  clientFor: null as null | ((hostKey: string) => Promise<SessionHostClient | null>)
}))
vi.mock('../session-host/session-host-runtime', () => ({
  activeRuntimeSessionHost: () => wiring.local
}))
vi.mock('../session-host-remote/remote-session-hosts-runtime', () => ({
  getRemoteSessionHosts: () => (wiring.clientFor ? { clientFor: wiring.clientFor } : null)
}))
vi.mock('./session-transfer-provider-version', () => ({
  localProviderVersion: async () => '2.1.0'
}))

const { relocateFromCommand } = await import('./session-transfer-relocate-command')

const CLAUDE_ID = '5b1f0c1e-7d7c-4c0e-9a55-0f1f2e3d4c5b'
const PERSON: SessionManageActor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Coordinator' }

let studio: TestComputer
let laptop: TestComputer
let userData: string
let disposers: (() => void)[] = []

beforeEach(async () => {
  const a = await testComputer('Studio')
  const b = await testComputer('Laptop')
  studio = a.computer
  laptop = b.computer
  userData = mkdtempSync(join(tmpdir(), 'relocate-command-'))
  disposers = [a.dispose, b.dispose, () => rmSync(userData, { recursive: true, force: true })]
  wiring.local = {
    service: async () => studio.service,
    serviceIfPresent: async () => studio.service
  }
})
afterEach(() => {
  for (const dispose of disposers) {
    dispose()
  }
  wiring.local = null
  wiring.clientFor = null
})

/** The laptop as another computer reaches it: its own gate, over a negotiated client. */
function laptopClient(advertise: (all: string[]) => string[] = (all) => all): SessionHostClient {
  laptop.capabilities = () => [SESSION_CONTROL_OWNER_CAPABILITY, ...laptop.actions().capabilities()]
  const capabilities = () => advertise(advertisableSessionHostCapabilities(laptop))
  const transport: SessionHostClientTransport = {
    probe: async () => ({
      status: 'advertised',
      capabilities: capabilities(),
      identity: laptop.service.identity
    }),
    call: async (method, params) => ({
      ok: true,
      result: await handleSessionHostRemoteCall(
        { capabilities: capabilities as never, service: async () => laptop.service },
        method,
        params,
        {
          transport: 'paired-runtime',
          peer: 'paired:studio',
          declared: readClientSessionHostDeclaration([...SESSION_HOST_CLIENT_CAPABILITIES]),
          connection: null
        }
      )
    }),
    connection: () => null
  }
  return new SessionHostClient(transport)
}

async function prepared(actor: SessionManageActor = PERSON): Promise<PreparedSessionAction> {
  const registration = await studio.conversation('claude', CLAUDE_ID, 4000)
  return {
    rows: [],
    row: {
      hostId: 'local',
      paneKey: registration.binding!.paneKey,
      worktreeId: registration.binding!.worktreeId
    },
    entry: {
      title: 'Parser fix',
      paneKey: registration.binding!.paneKey,
      tabId: null,
      agent: 'claude',
      ref: `claude:${CLAUDE_ID}@local`,
      worktreePath: null
    },
    source: registration.binding,
    agentProcess: null,
    actor
  } as unknown as PreparedSessionAction
}

function run(target: PreparedSessionAction, extra: Record<string, unknown> = {}) {
  return relocateFromCommand({
    runtime: {} as never,
    userDataPath: userData,
    prepared: target,
    params: {
      to: 'runtime:laptop',
      workspace: '/work/Laptop',
      reason: 'Needs the laptop',
      ...extra
    }
  })
}

describe('omni session relocate', () => {
  it('moves a conversation from this computer to a paired one through its own gate', async () => {
    wiring.clientFor = async () => laptopClient()
    const target = await prepared()
    const result = await run(target)
    expect([result.outcome, result.ownerEpoch, result.provider]).toEqual(['relocated', 2, 'claude'])
    expect(result.destination.label).toBe('runtime:laptop')
    expect(laptop.launched.map((launch) => launch.sessionId)).toEqual([CLAUDE_ID])
    expect(readFileSync(laptop.launched[0]!.transcriptPath, 'utf8')).toBe(
      readFileSync(studio.transcriptOf({ agent: 'claude', sessionId: CLAUDE_ID })!, 'utf8')
    )
    expect(Object.values(studio.service.store.snapshot()!.conversations)[0]!.owned).toBe(false)
  })

  it('only plans in a dry run and only proposes for an automatic caller', async () => {
    wiring.clientFor = async () => laptopClient()
    const planned = await run(await prepared(), { dryRun: true })
    expect(planned.outcome).toBe('planned')
    const steward: SessionManageActor = { kind: 'steward', feature: 'rules' }
    const proposed = await run(await prepared(steward))
    expect(proposed.outcome).toBe('proposed')
    expect(Object.keys(studio.service.store.snapshot()!.operations)).toEqual([])
    expect(Object.keys(laptop.service.store.snapshot()!.operations)).toEqual([])
  })

  it('refuses a computer whose OmniConsole relocates but cannot move bundles, before anything moves', async () => {
    wiring.clientFor = async () =>
      laptopClient((all) => all.filter((name) => name !== SESSION_RELOCATION_BUNDLE_CAPABILITY))
    const result = await run(await prepared())
    expect([result.outcome, result.code]).toEqual(['refused', 'unsupported-capability'])
    expect(Object.keys(studio.service.store.snapshot()!.operations)).toEqual([])
    expect(laptop.launched).toEqual([])
  })

  it('refuses an SSH host as the destination before any host is asked, dry run included', async () => {
    const clientFor = vi.fn(async () => laptopClient())
    wiring.clientFor = clientFor
    for (const dryRun of [false, true]) {
      await expect(run(await prepared(), { to: 'ssh:box-1', dryRun })).rejects.toThrow(
        /ssh:box-1 is an SSH host, which cannot take a moved conversation yet/
      )
    }
    expect(clientFor).not.toHaveBeenCalled()
    expect(Object.keys(studio.service.store.snapshot()!.operations)).toEqual([])
  })

  it('refuses a computer this Mac cannot reach, and a move to where it already runs', async () => {
    wiring.clientFor = async () => null
    await expect(run(await prepared())).rejects.toThrow(/could not be reached/)
    await expect(run(await prepared(), { to: 'local' })).rejects.toThrow(
      /already runs on this computer/
    )
  })
})
