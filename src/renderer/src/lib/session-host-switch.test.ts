import { describe, expect, it } from 'vitest'
import type { ExecutionHostId, ExecutionHostKind } from '../../../shared/execution-host'
import {
  HOME_SESSION_HOST_FILTER,
  sessionsInHostFilter,
  toggleSessionHostKind
} from './session-host-scope'
import {
  everywhereSessionHostFilter,
  homeSessionHostFilter,
  onlySessionHostFilter,
  sameSessionHostFilter,
  showsSessionHostKind
} from './session-host-switch'
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
const filter = (kinds: ExecutionHostKind[], hiddenHostIds: ExecutionHostId[] = []) => ({
  kinds,
  hiddenHostIds
})

describe('Home and the Globe are one switch', () => {
  it('the Globe shows this computer and every paired runtime in one click, from anywhere', () => {
    expect(everywhereSessionHostFilter(HOME_SESSION_HOST_FILTER)).toEqual(
      filter(['local', 'runtime'])
    )
    // Narrowed to one runtime from the picker: the Globe widens back to all of them.
    expect(everywhereSessionHostFilter(filter(['local', 'runtime'], [MINI]))).toEqual(
      filter(['local', 'runtime'])
    )
    // One computer alone brings Home back along.
    expect(everywhereSessionHostFilter(filter(['runtime'], [MINI]))).toEqual(
      filter(['local', 'runtime'])
    )
    // The plug is left as it was, its own narrowing included.
    expect(everywhereSessionHostFilter(filter(['local', 'ssh'], [VM]))).toEqual(
      filter(['local', 'runtime', 'ssh'], [VM])
    )
  })

  it('Home shows this computer only in one click, leaving the plug alone', () => {
    expect(homeSessionHostFilter(filter(['local', 'runtime']))).toEqual(HOME_SESSION_HOST_FILTER)
    expect(homeSessionHostFilter(filter(['runtime'], [MINI]))).toEqual(HOME_SESSION_HOST_FILTER)
    expect(homeSessionHostFilter(filter(['local', 'runtime', 'ssh'], [VM]))).toEqual(
      filter(['local', 'ssh'], [VM])
    )
    expect(homeSessionHostFilter(HOME_SESSION_HOST_FILTER)).toEqual(HOME_SESSION_HOST_FILTER)
  })

  it('Globe, Home, Globe again lands on every paired runtime: no click is ever dead', () => {
    const globe = everywhereSessionHostFilter(HOME_SESSION_HOST_FILTER)
    expect(showsSessionHostKind(globe, 'runtime', HOSTS)).toBe(true)
    const home = homeSessionHostFilter(globe)
    expect(showsSessionHostKind(home, 'runtime', HOSTS)).toBe(false)
    expect(sessionsInHostFilter([session('big', BIGMAC)], [], home).sessions).toEqual([])
    const again = everywhereSessionHostFilter(home)
    expect(again).toEqual(filter(['local', 'runtime']))
    expect(showsSessionHostKind(again, 'runtime', HOSTS)).toBe(true)
    // The kind toggle, by contrast, refuses to turn off the last kind shown: a dead click.
    expect(toggleSessionHostKind(filter(['runtime']), 'runtime', HOSTS)).toEqual(
      filter(['runtime'])
    )
  })

  it('tells a view moved by the person from one written again with the same hosts', () => {
    const home = { kinds: ['local'], hiddenHostIds: [] }
    expect(sameSessionHostFilter(home, { kinds: ['local'] })).toBe(true)
    expect(
      sameSessionHostFilter(
        { kinds: ['ssh', 'local'], hiddenHostIds: [VM] },
        filter(['local', 'ssh'], [VM])
      )
    ).toBe(true)
    expect(sameSessionHostFilter(home, filter(['local', 'runtime']))).toBe(false)
    expect(sameSessionHostFilter(filter(['runtime'], [MINI]), filter(['runtime'], [BIGMAC]))).toBe(
      false
    )
    expect(sameSessionHostFilter(undefined, undefined)).toBe(true)
    expect(sameSessionHostFilter(undefined, home)).toBe(false)
  })

  it('picking one computer shows it alone, the plug as it was; picking this one is Home', () => {
    expect(onlySessionHostFilter(filter(['local', 'runtime']), BIGMAC, HOSTS)).toEqual(
      filter(['runtime'], [MINI])
    )
    expect(onlySessionHostFilter(filter(['local', 'ssh'], [VM]), MINI, HOSTS)).toEqual(
      filter(['runtime', 'ssh'], [VM, BIGMAC])
    )
    expect(onlySessionHostFilter(filter(['runtime'], [MINI]), 'local', HOSTS)).toEqual(
      HOME_SESSION_HOST_FILTER
    )
  })
})
