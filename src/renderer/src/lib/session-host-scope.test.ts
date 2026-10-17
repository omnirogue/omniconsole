import { describe, expect, it } from 'vitest'
import type { ExecutionHostId, ExecutionHostKind } from '../../../shared/execution-host'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import {
  HOME_SESSION_HOST_FILTER,
  effectiveSessionHostFilter,
  hideSessionHostKind,
  inSessionHostFilter,
  legacySessionHostScope,
  onlySessionHostKind,
  sessionAsksByHost,
  sessionCountBucketsByHost,
  sessionCountsByHost,
  sessionHostKindMarks,
  sessionsInHostFilter,
  showAllSessionHostsOfKind,
  toggleSessionHost,
  toggleSessionHostKind,
  type SessionHostFilter
} from './session-host-scope'
import type { SidebarSession } from './sidebar-sessions'

const BIGMAC = 'runtime:bigmac' as const
const MINI = 'runtime:mini' as const
const VM = 'ssh:vm' as const
const host = (id: ExecutionHostId, kind: ExecutionHostKind) => ({ id, kind })
const HOSTS = [
  host('local', 'local'),
  host(BIGMAC, 'runtime'),
  host(MINI, 'runtime'),
  host(VM, 'ssh')
]

const session = (key: string, hostId: ExecutionHostId | null) =>
  ({ rowKey: key, sessionKey: key, hostId }) as SidebarSession
const run = (sessionKey: string) =>
  ({ rowKey: sessionKey, sessionKey, admission: 'accepted' }) as unknown as ConversationFleetView
const filter = (kinds: ExecutionHostKind[], hiddenHostIds: ExecutionHostId[] = []) => ({
  kinds,
  hiddenHostIds
})

describe('effectiveSessionHostFilter', () => {
  it('is Home by default and reads what older builds saved', () => {
    expect(effectiveSessionHostFilter({}, HOSTS)).toEqual(HOME_SESSION_HOST_FILTER)
    expect(effectiveSessionHostFilter({ hostScope: 'all' }, HOSTS)).toEqual(
      filter(['local', 'runtime', 'ssh'])
    )
    // One host chosen alone becomes its kind with the kind's other hosts turned off.
    expect(effectiveSessionHostFilter({ hostScope: BIGMAC }, HOSTS)).toEqual(
      filter(['runtime'], [MINI])
    )
    expect(effectiveSessionHostFilter({ hostScope: 'not a host' }, HOSTS)).toEqual(
      HOME_SESSION_HOST_FILTER
    )
  })

  it('prefers the saved filter, dropping values it cannot read', () => {
    const saved = { kinds: ['ssh', 'bogus', 'local'], hiddenHostIds: ['nope', 'local', MINI] }
    expect(effectiveSessionHostFilter({ hostFilter: saved, hostScope: BIGMAC }, HOSTS)).toEqual(
      filter(['local', 'ssh'], [MINI])
    )
  })

  it('falls back to Home rather than an empty list', () => {
    // Every chosen host was removed, or the one runtime shown is gone.
    expect(effectiveSessionHostFilter({ hostScope: 'runtime:gone' }, HOSTS)).toEqual(
      HOME_SESSION_HOST_FILTER
    )
    expect(effectiveSessionHostFilter({ hostFilter: { kinds: [] } }, HOSTS)).toEqual(
      HOME_SESSION_HOST_FILTER
    )
    expect(
      effectiveSessionHostFilter(
        { hostFilter: { kinds: ['runtime'], hiddenHostIds: [BIGMAC, MINI] } },
        HOSTS
      )
    ).toEqual(HOME_SESSION_HOST_FILTER)
  })
})

describe('sessionsInHostFilter', () => {
  const sessions = [
    session('here', 'local'),
    session('orphan', null),
    session('big', BIGMAC),
    session('mini', MINI),
    session('ssh', VM)
  ]
  const keys = (value: SessionHostFilter) =>
    sessionsInHostFilter(sessions, [], value).sessions.map((entry) => entry.rowKey)

  it('shows the union of the chosen kinds, less hosts turned off', () => {
    // A tab whose workspace is gone has no host; it was kept on this computer.
    expect(keys(HOME_SESSION_HOST_FILTER)).toEqual(['here', 'orphan'])
    expect(keys(filter(['local', 'ssh']))).toEqual(['here', 'orphan', 'ssh'])
    expect(keys(filter(['runtime', 'ssh'], [MINI]))).toEqual(['big', 'ssh'])
    expect(keys(filter(['local', 'runtime', 'ssh']))).toEqual([
      'here',
      'orphan',
      'big',
      'mini',
      'ssh'
    ])
    expect(inSessionHostFilter(null, filter(['runtime']))).toBe(false)
  })

  it('keeps unplaced runs with their source and never assumes discovered runs are local', () => {
    const runs = [run('here'), run('big'), run('sent-then-closed')]
    const runKeys = (value: SessionHostFilter) =>
      sessionsInHostFilter(sessions, runs, value).fleetRuns.map((entry) => entry.sessionKey)
    expect(runKeys(HOME_SESSION_HOST_FILTER)).toEqual(['here'])
    expect(runKeys(filter(['runtime']))).toEqual(['big'])
  })

  // Why (session counts, step 9): a hostless row may be a paired computer's, so it is never
  // counted as this computer's, though the Home list still shows it (above).
  it('counts sessions per host, never a hostless one as Home', () => {
    expect([...sessionCountsByHost(sessions)]).toEqual([
      ['local', 1],
      [BIGMAC, 1],
      [MINI, 1],
      [VM, 1]
    ])
  })

  // Session parity (step 8): the same rows, split by bucket — the total never changes.
  it('splits each host count by parity bucket, the buckets adding up to that count', () => {
    const rows = [
      { hostId: BIGMAC, displayHostId: undefined, bucket: 'ownerListed', archived: true },
      { hostId: BIGMAC, displayHostId: undefined, bucket: 'receiverOnly', doubt: 'unverified' },
      { hostId: BIGMAC, displayHostId: undefined, bucket: 'heldByOwner', doubt: 'stale' },
      { hostId: VM, displayHostId: 'local', bucket: 'workflow' },
      { hostId: null, displayHostId: undefined, bucket: 'receiverOnly', doubt: 'unverified' }
    ] as const
    const buckets = sessionCountBucketsByHost(rows, (row) => ({
      bucket: row.bucket,
      verification: 'doubt' in row ? row.doubt : 'verified',
      archived: 'archived' in row
    }))
    expect([...buckets]).toEqual([
      [
        BIGMAC,
        {
          ownerListed: 1,
          heldByOwner: 1,
          receiverOnly: 1,
          workflow: 0,
          unverified: 1,
          stale: 1,
          archived: 1
        }
      ],
      [
        'local',
        {
          ownerListed: 0,
          heldByOwner: 0,
          receiverOnly: 0,
          workflow: 1,
          unverified: 0,
          stale: 0,
          archived: 0
        }
      ]
    ])
    // The same hosts and totals sessionCountsByHost counts; the hostless row is in neither.
    const totals = sessionCountsByHost(rows)
    for (const [hostId, split] of buckets) {
      expect(split.ownerListed + split.heldByOwner + split.receiverOnly + split.workflow).toBe(
        totals.get(hostId)
      )
    }
    expect([...totals.keys()]).toEqual([...buckets.keys()])
  })

  it('puts fleet work on its execution computer, including after its source tab closes', () => {
    const remote = {
      ...run('here'),
      machine: 'studio',
      jobs: []
    } as unknown as ConversationFleetView
    const hosts = [
      { id: BIGMAC, label: 'studio' },
      { id: MINI, label: 'mini' }
    ]
    expect(
      sessionsInHostFilter(sessions, [remote], HOME_SESSION_HOST_FILTER, hosts).fleetRuns
    ).toEqual([])
    expect(
      sessionsInHostFilter([], [remote], filter(['runtime'], [MINI]), hosts).fleetRuns
    ).toEqual([remote])
    expect(
      sessionsInHostFilter([], [remote], filter(['runtime'], [BIGMAC]), hosts).fleetRuns
    ).toEqual([])
    expect(sessionsInHostFilter([], [remote], HOME_SESSION_HOST_FILTER, []).fleetRuns).toEqual([])
  })
})

describe('changing the filter', () => {
  it('toggles a kind on and off, never leaving nothing shown', () => {
    const both = toggleSessionHostKind(HOME_SESSION_HOST_FILTER, 'ssh', HOSTS)
    expect(both).toEqual(filter(['local', 'ssh']))
    expect(toggleSessionHostKind(both, 'local', HOSTS)).toEqual(filter(['ssh']))
    // Turning off the last kind shown keeps it.
    expect(toggleSessionHostKind(HOME_SESSION_HOST_FILTER, 'local', HOSTS)).toBe(
      HOME_SESSION_HOST_FILTER
    )
  })

  it('brings a kind back as last narrowed, or whole when every host of it was off', () => {
    const narrowed = filter(['local'], [MINI])
    expect(toggleSessionHostKind(narrowed, 'runtime', HOSTS)).toEqual(
      filter(['local', 'runtime'], [MINI])
    )
    const allOff = filter(['local', 'runtime'], [BIGMAC, MINI])
    expect(toggleSessionHostKind(allOff, 'runtime', HOSTS)).toEqual(filter(['local', 'runtime']))
  })

  it('toggles one host, and picking a host of a kind that was off shows only that host', () => {
    const home = HOME_SESSION_HOST_FILTER
    expect(toggleSessionHost(home, MINI, HOSTS)).toEqual(filter(['local', 'runtime'], [BIGMAC]))
    const runtimes = filter(['runtime'])
    expect(toggleSessionHost(runtimes, MINI, HOSTS)).toEqual(filter(['runtime'], [MINI]))
    expect(toggleSessionHost(filter(['runtime'], [MINI]), MINI, HOSTS)).toEqual(runtimes)
    // The last host shown stays on.
    const lone = filter(['runtime'], [MINI])
    expect(toggleSessionHost(lone, BIGMAC, HOSTS)).toBe(lone)
  })

  it('shows only one kind, or every host of a kind', () => {
    expect(onlySessionHostKind(filter(['local', 'ssh'], [MINI]), 'runtime', HOSTS)).toEqual(
      filter(['runtime'], [MINI])
    )
    expect(showAllSessionHostsOfKind(filter(['local'], [MINI]), 'runtime')).toEqual(
      filter(['local', 'runtime'])
    )
  })

  it('tells older builds the one host shown, else every host', () => {
    expect(legacySessionHostScope(HOME_SESSION_HOST_FILTER, HOSTS)).toBe('local')
    expect(legacySessionHostScope(filter(['runtime'], [MINI]), HOSTS)).toBe(BIGMAC)
    expect(legacySessionHostScope(filter(['local', 'ssh']), HOSTS)).toBe('all')
  })
})

describe('the switch keeps up with the hosts it lists', () => {
  it('drops turned-off hosts it no longer lists, without losing the rest', () => {
    const saved = { hostFilter: { kinds: ['local', 'ssh'], hiddenHostIds: [VM, 'ssh:gone'] } }
    expect(effectiveSessionHostFilter(saved, HOSTS)).toEqual(filter(['local', 'ssh'], [VM]))
    expect(
      effectiveSessionHostFilter(
        saved,
        HOSTS.filter((each) => each.id !== VM)
      )
    ).toEqual(filter(['local', 'ssh']))
  })

  it('turns SSH hosts on from Home in one click, off in a second, and None never empties it', () => {
    const on = toggleSessionHostKind(HOME_SESSION_HOST_FILTER, 'ssh', HOSTS)
    expect(on).toEqual(filter(['local', 'ssh']))
    expect(toggleSessionHostKind(on, 'ssh', HOSTS)).toEqual(HOME_SESSION_HOST_FILTER)
    expect(hideSessionHostKind(on, 'ssh', HOSTS)).toEqual(HOME_SESSION_HOST_FILTER)
    const sshOnly = filter(['ssh'])
    expect(hideSessionHostKind(sshOnly, 'ssh', HOSTS)).toBe(sshOnly)
  })
})

describe('the marks on a kind icon', () => {
  const ASKING = { paneKey: 'asks' } as unknown as SidebarSession
  const snapshot = (attention: Record<string, unknown>) => ({
    cardsByPaneKey: new Map(),
    cardsByTabId: new Map(),
    attentionByPaneKey: new Map([['asks', attention]])
  })
  const asking = (key: string, hostId: ExecutionHostId) =>
    ({ ...ASKING, rowKey: key, sessionKey: key, hostId }) as SidebarSession

  it('counts asks per host over every session, leaving an ask a fleet run carries to the run', () => {
    const sessions = [asking('a', VM), asking('b', VM), session('quiet', BIGMAC)]
    expect([...sessionAsksByHost(sessions, snapshot({}) as never)]).toEqual([[VM, 2]])
    expect([...sessionAsksByHost(sessions, snapshot({ run: {} }) as never)]).toEqual([])
    const workflow = { ...session('flow', MINI), workflow: { status: 'needs-you' } }
    expect([...sessionAsksByHost([workflow as SidebarSession], snapshot({}) as never)]).toEqual([
      [MINI, 1]
    ])
  })

  it('counts hosts in view with sessions and flags an ask on a host out of view', () => {
    const counts = new Map<ExecutionHostId, number>([
      ['local', 4],
      [BIGMAC, 2],
      [MINI, 1],
      [VM, 0]
    ])
    const asks = new Map<ExecutionHostId, number>([[MINI, 1]])
    expect(sessionHostKindMarks('runtime', filter(['local', 'runtime']), counts, asks)).toEqual({
      hostsWithSessions: 2,
      asksElsewhere: false
    })
    expect(
      sessionHostKindMarks('runtime', filter(['local', 'runtime'], [MINI]), counts, asks)
    ).toEqual({ hostsWithSessions: 1, asksElsewhere: true })
    expect(sessionHostKindMarks('ssh', filter(['local', 'ssh']), counts, asks)).toEqual({
      hostsWithSessions: 0,
      asksElsewhere: false
    })
  })
})
