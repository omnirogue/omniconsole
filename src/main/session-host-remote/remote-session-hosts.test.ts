import { describe, expect, it, vi } from 'vitest'
import type { SessionHostClientTransport } from '../../shared/session-host-client'
import {
  SESSION_CONTROL_DELIVERY_CAPABILITY,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY
} from '../../shared/session-host-capabilities'
import type { SessionHostNegotiation } from '../../shared/session-host-negotiation'
import type { SessionHostReceivedObservation } from '../../shared/session-host-reply-schema'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageActor } from '../../shared/session-manage-types'
import {
  FIXTURE_HOST,
  legacyRuntimeStatus,
  phase4RelayPtyCapabilities,
  phase4RuntimeStatus
} from '../../shared/session-host-wire-fixtures'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import {
  REMOTE_HOST_REFRESH_MS,
  RemoteSessionHosts,
  remoteHostCounts,
  remoteHostState
} from './remote-session-hosts'
import { remoteOrigin, remoteSessionManage } from './remote-session-manage'

function observation(
  n: number,
  verdict: 'live' | 'exited' | 'unverifiable',
  entry: Record<string, unknown> = {}
): SessionHostReceivedObservation {
  const conversationId = `conv_${n.toString(16).padStart(32, '0')}`
  return {
    conversationId,
    ownerEpoch: 1,
    turnRevision: 'turn:1',
    verdict,
    admission: 'open',
    provider: null,
    ref: {
      hostId: FIXTURE_HOST.hostId,
      conversationId,
      paneKey: null,
      tabId: null,
      worktreePath: null
    },
    entry
  }
}

function negotiation(extra: Partial<SessionHostNegotiation>): SessionHostNegotiation {
  return {
    side: 'client',
    peerStatus: 'advertised',
    peer: FIXTURE_HOST,
    connection: null,
    agreed: [],
    gaps: [],
    unknownPeerCapabilities: [],
    ...extra
  }
}

describe('what each other computer is, at a glance', () => {
  it('names unreachable, older, controls-off and ready from the negotiation alone', () => {
    expect(remoteHostState(null)).toEqual({ state: 'unreachable' })
    expect(remoteHostState(negotiation({ peerStatus: 'absent', peer: null }))).toEqual({
      state: 'older'
    })
    expect(remoteHostState(negotiation({ agreed: [] }))).toEqual({ state: 'controls-off' })
    expect(remoteHostState(negotiation({ agreed: [SESSION_CONTROL_OWNER_CAPABILITY] }))).toEqual({
      state: 'ready'
    })
  })

  it('folds a hundred sessions into one line of counts, by the owner’s verdict and state', () => {
    const sessions = [
      ...Array.from({ length: 60 }, (_, n) => observation(n, 'live', { state: 'idle' })),
      ...Array.from({ length: 25 }, (_, n) => observation(100 + n, 'live', { state: 'working' })),
      ...Array.from({ length: 5 }, (_, n) =>
        observation(200 + n, 'live', { state: 'awaiting-user', stalled: { at: 1, reason: 'x' } })
      ),
      ...Array.from({ length: 10 }, (_, n) => observation(300 + n, 'exited'))
    ]
    expect(remoteHostCounts(sessions)).toEqual({
      total: 100,
      live: 90,
      exited: 10,
      unverifiable: 0,
      working: 25,
      needsYou: 5,
      stalled: 5
    })
  })
})

function statusTransport(status: unknown, sessions: SessionHostReceivedObservation[]) {
  const calls: string[] = []
  const transport: SessionHostClientTransport = {
    probe: async () => {
      calls.push('probe')
      const { readRuntimeSessionHostAdvertisement } =
        await import('../../shared/session-host-capabilities')
      return readRuntimeSessionHostAdvertisement(status)
    },
    call: async (method) => {
      calls.push(method)
      return {
        ok: true,
        result: { status: 'ok', host: FIXTURE_HOST, observedAt: 1, complete: true, sessions },
        incarnation: FIXTURE_HOST.incarnation
      }
    },
    connection: () => null
  }
  return { transport, calls }
}

describe('reading the other computers', () => {
  it('reads each stale host once, keeps its snapshot, and waits a minute before the next', async () => {
    const clock = { now: 1_000 }
    const ready = statusTransport(phase4RuntimeStatus(), [
      observation(1, 'live', { state: 'working' })
    ])
    const older = statusTransport(legacyRuntimeStatus(), [])
    const connect = vi.fn(async (key: string) =>
      key === 'runtime:studio' ? ready.transport : key === 'runtime:old' ? older.transport : null
    )
    const hosts = new RemoteSessionHosts({ connect, now: () => clock.now })
    const keys = ['runtime:studio', 'runtime:old', 'local', 'runtime:studio']
    expect(hosts.snapshots(keys).map((snapshot) => snapshot.state)).toEqual([
      'checking',
      'checking'
    ])
    await hosts.refresh(keys)
    const [studio, old] = hosts.snapshots(keys)
    expect(studio).toMatchObject({
      state: 'ready',
      hostId: FIXTURE_HOST.hostId,
      counts: { total: 1, working: 1 }
    })
    expect(old).toMatchObject({ state: 'older', counts: null })
    // Why no observe on the older one: nothing it cannot answer is ever sent.
    expect(older.calls).toEqual(['probe'])
    await hosts.refresh(keys)
    expect(ready.calls.filter((call) => call === 'probe')).toHaveLength(1)
    clock.now += REMOTE_HOST_REFRESH_MS
    await hosts.refresh(keys)
    expect(ready.calls.filter((call) => call === 'probe')).toHaveLength(2)
    expect(hosts.directory.ownerOf(observation(1, 'live').conversationId)).toEqual({
      hostId: FIXTURE_HOST.hostId,
      ownerEpoch: 1
    })
  })
})

describe('an SSH relay with package B2', () => {
  it('reads ready, and lists that it takes this Mac’s automatic prompts (delivery)', async () => {
    const { readRelaySessionHostAdvertisement } =
      await import('../../shared/session-host-capabilities')
    const declared: string[][] = []
    const relay: SessionHostClientTransport = {
      probe: async () =>
        readRelaySessionHostAdvertisement(
          phase4RelayPtyCapabilities([
            SESSION_CONTROL_OWNER_CAPABILITY,
            SESSION_WAITS_REMOTE_CAPABILITY,
            SESSION_CONTROL_DELIVERY_CAPABILITY
          ])
        ),
      declare: async (capabilities) => {
        declared.push([...capabilities])
        return null
      },
      call: async () => ({
        ok: true,
        result: { status: 'ok', host: FIXTURE_HOST, observedAt: 1, complete: true, sessions: [] }
      }),
      connection: () => '1:1'
    }
    const hosts = new RemoteSessionHosts({ connect: async () => relay, now: () => 1 })
    const snapshot = await hosts.refreshHost('ssh:build')
    expect(snapshot).toMatchObject({ kind: 'ssh', state: 'ready', counts: { total: 0 } })
    expect(snapshot!.capabilities.toSorted()).toEqual(
      [
        SESSION_CONTROL_DELIVERY_CAPABILITY,
        SESSION_CONTROL_OWNER_CAPABILITY,
        SESSION_WAITS_REMOTE_CAPABILITY
      ].toSorted()
    )
    expect(declared[0]).toContain(SESSION_CONTROL_DELIVERY_CAPABILITY)
  })
})

const REMOTE_ROW = { hostId: 'runtime:studio' } as SessionManageSidebarRow
const ENTRY = { title: 'Release notes', paneKey: 'tab-1:leaf', tabId: null }
const PERSON: SessionManageActor = { kind: 'pane', paneKey: 'tab-9:me', title: 'Planner' }

describe('this Mac’s own rules come first', () => {
  it('never lets an unattended caller reach another computer', () => {
    for (const actor of [
      { kind: 'steward', feature: 'rules' },
      { kind: 'cli', unattended: { source: 'cleanup-run' } },
      { kind: 'pane', paneKey: 'p', title: 't', unattended: { source: 'rules' } }
    ] as SessionManageActor[]) {
      expect(() => remoteOrigin(actor, {})).toThrow(SessionManageRefusal)
    }
    expect(remoteOrigin(PERSON, { request: 'keep going' }, 'Studio.local')).toEqual({
      computer: 'Studio',
      requester: { kind: 'pane', paneKey: 'tab-9:me', title: 'Planner' },
      request: 'keep going'
    })
  })

  it('leaves a session this computer runs to the local path', async () => {
    await expect(
      remoteSessionManage({
        hosts: null,
        row: { hostId: 'local' } as SessionManageSidebarRow,
        entry: ENTRY,
        actor: PERSON,
        request: { action: 'continue', payload: { answer: { kind: 'yes' } } },
        provenance: {},
        dryRun: false
      })
    ).resolves.toBeNull()
  })

  it('explains a host it cannot reach instead of doing anything here', async () => {
    await expect(
      remoteSessionManage({
        hosts: null,
        row: REMOTE_ROW,
        entry: ENTRY,
        actor: PERSON,
        request: { action: 'restart', payload: {} },
        provenance: {},
        dryRun: false
      })
    ).rejects.toThrow(/cannot reach the session host/)
  })

  it('keeps stop’s existing path where the host offers no owner control, and nowhere else', async () => {
    const older = statusTransport(legacyRuntimeStatus(), [])
    const hosts = new RemoteSessionHosts({ connect: async () => older.transport, now: () => 1 })
    const run = (action: 'stop' | 'continue') =>
      remoteSessionManage({
        hosts,
        row: REMOTE_ROW,
        entry: ENTRY,
        actor: PERSON,
        request:
          action === 'stop'
            ? { action: 'stop', payload: {} }
            : { action: 'continue', payload: { answer: { kind: 'yes' } } },
        provenance: {},
        dryRun: false
      })
    await expect(run('stop')).resolves.toBeNull()
    await expect(run('continue')).rejects.toThrow(/OmniConsole predates/)
  })
})
