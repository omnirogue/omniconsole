import { describe, expect, it } from 'vitest'
import type { SidebarSession } from './sidebar-sessions'
import { projectWorkflowExecutionHosts } from './workflow-execution-hosts'
import { sessionCountsByHost, sessionsInHostFilter } from './session-host-scope'
import { sessionHostOptions } from '@/components/sidebar/session-folders/session-host-options'
import type { SidebarHostOption } from '@/components/sidebar/sidebar-host-options'

const hosts: SidebarHostOption[] = [
  {
    id: 'local',
    label: 'This computer',
    kind: 'local',
    detail: '',
    health: 'local',
    presence: 'local'
  },
  {
    id: 'ssh:worker',
    label: 'mw0001',
    kind: 'ssh',
    detail: '',
    health: 'available',
    presence: 'configured'
  },
  {
    id: 'runtime:worker',
    label: 'mw0001',
    kind: 'runtime',
    detail: '',
    health: 'available',
    presence: 'configured'
  }
]
const row = {
  rowKey: 'controller-row',
  hostId: 'local',
  tabId: 'discover-tab',
  unavailable: false,
  label: 'Find bugs',
  workflow: { preset: 'discover', status: 'running', host: 'mw0001', sshHost: 'mw0001' }
} as SidebarSession

describe('workflow execution computer in the sidebar', () => {
  it('shows SSH work under its worker computer while keeping the controller identity and one row', () => {
    const located = projectWorkflowExecutionHosts([row], hosts)
    expect(located[0]).toMatchObject({
      displayHostId: 'ssh:worker',
      hostId: 'local',
      rowKey: row.rowKey,
      tabId: row.tabId,
      label: row.label
    })
    expect(row.displayHostId).toBeUndefined()
    expect(
      sessionsInHostFilter(located, [], { kinds: ['ssh'], hiddenHostIds: [] }).sessions
    ).toEqual(located)
    expect(
      sessionsInHostFilter(located, [], { kinds: ['local', 'runtime'], hiddenHostIds: [] }).sessions
    ).toEqual([])
    expect(
      sessionsInHostFilter(located, [], { kinds: ['local', 'runtime', 'ssh'], hiddenHostIds: [] })
        .sessions
    ).toHaveLength(1)
    expect(
      sessionsInHostFilter(located, [], { kinds: ['ssh'], hiddenHostIds: ['ssh:worker'] }).sessions
    ).toEqual([])
    expect([...sessionCountsByHost(located)]).toEqual([['ssh:worker', 1]])
    expect(
      sessionHostOptions(
        hosts,
        located,
        { sshTargetLabels: new Map(), runtimeEnvironments: [] },
        new Set()
      ).hosts
    ).toContain(hosts[1])
  })

  it('never infers a transport from a caption or borrows the paired computer with the same name', () => {
    const older = { ...row, workflow: { ...row.workflow!, sshHost: undefined } }
    expect(projectWorkflowExecutionHosts([older], hosts)[0]).toBe(older)
    expect(
      projectWorkflowExecutionHosts(
        [row],
        hosts.filter((host) => host.kind !== 'ssh')
      )[0]
    ).toBe(row)
    expect(
      projectWorkflowExecutionHosts([row], [...hosts, { ...hosts[1]!, id: 'ssh:duplicate' }])[0]
    ).toBe(row)
  })
})
