import { describe, expect, it, vi } from 'vitest'
import type { SidebarHostOption } from '../sidebar-host-options'
import { sessionHostOptions } from './session-host-options'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

const LOCAL: SidebarHostOption = {
  id: 'local',
  kind: 'local',
  label: 'Local',
  detail: 'This computer',
  health: 'local',
  presence: 'local'
}
const LABELS = {
  sshTargetLabels: new Map([['vm1', 'Build VM']]),
  runtimeEnvironments: [{ id: 'mini', name: 'mw0003' }]
}

describe('sessionHostOptions', () => {
  it('adds each host only sessions still name, once, named as the session details name it', () => {
    const options = sessionHostOptions(
      [LOCAL],
      [
        { hostId: 'local', unavailable: false },
        { hostId: null, unavailable: true },
        { hostId: 'ssh:vm1', unavailable: true },
        { hostId: 'ssh:vm1', unavailable: false },
        { hostId: 'runtime:mini', unavailable: true },
        { hostId: 'runtime:gone', unavailable: true }
      ],
      LABELS,
      new Set()
    )
    expect(options.hosts.map((host) => [host.id, host.label, host.health])).toEqual([
      ['local', 'Local', 'local'],
      // Reachable once any of its sessions is.
      ['ssh:vm1', 'Build VM', 'available'],
      ['runtime:mini', 'mw0003', 'disconnected'],
      // A removed server keeps a name: its id.
      ['runtime:gone', 'gone', 'disconnected']
    ])
  })

  it('leaves the set-up hosts as they are', () => {
    const bigmac: SidebarHostOption = {
      ...LOCAL,
      id: 'runtime:bigmac',
      kind: 'runtime',
      label: 'BigMac',
      health: 'available',
      presence: 'configured'
    }
    expect(
      sessionHostOptions(
        [LOCAL, bigmac],
        [{ hostId: 'runtime:bigmac', unavailable: true }],
        LABELS,
        new Set()
      )
    ).toEqual({ hosts: [LOCAL, bigmac], sshWithoutWorkspace: 0 })
  })

  it('lists only the SSH hosts a session can be dispatched to and counts the rest', () => {
    const saved = Array.from({ length: 30 }, (_, index): SidebarHostOption => ({
      ...LOCAL,
      id: `ssh:host${index}`,
      kind: 'ssh',
      label: `host${index}`,
      health: 'disconnected',
      presence: 'configured'
    }))
    const options = sessionHostOptions(
      [LOCAL, ...saved],
      [{ hostId: 'ssh:host29', unavailable: false }],
      LABELS,
      new Set(['host0', 'host1', 'host2'])
    )
    expect(options.hosts.map((host) => host.id)).toEqual([
      'local',
      'ssh:host0',
      'ssh:host1',
      'ssh:host2',
      // No workspace, but a session still runs there.
      'ssh:host29'
    ])
    expect(options.sshWithoutWorkspace).toBe(26)
    const noSessions = sessionHostOptions(
      [LOCAL, ...saved],
      [],
      LABELS,
      new Set(['host0', 'host1', 'host2'])
    )
    expect(noSessions.hosts).toHaveLength(4)
    expect(noSessions.sshWithoutWorkspace).toBe(27)
  })
})
