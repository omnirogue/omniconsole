import { describe, expect, it } from 'vitest'
import {
  chooseWorkflowFleetHost,
  WORKFLOW_FLEET_READING_FRESH_MS,
  buildReviewDispatchedSeatsRefusal,
  workflowFleetPlacementRefusal,
  workflowNamedHostHotRefusal,
  workflowPlacementSummary,
  workflowPlacementCapacityText,
  type WorkflowPlacementCandidate,
  type WorkflowPlacementCapacity
} from './local-workflow-placement'

const NOW = 1_800_000_000_000

function host(
  name: string,
  capacity: WorkflowPlacementCapacity,
  change: Partial<WorkflowPlacementCandidate> = {}
): WorkflowPlacementCandidate {
  return { name, machine: name, ssh: name, cores: 16, heavyOk: true, capacity, ...change }
}

const fresh = (loadPerCore: number, readAt = NOW): WorkflowPlacementCapacity => ({
  state: 'fresh',
  loadPerCore,
  readAt
})

describe('choosing a fleet host', () => {
  it('takes the most spare fresh reading under the 60 percent rule, ties by name', () => {
    const chosen = chooseWorkflowFleetHost(
      [
        host('mw0002', fresh(0.31)),
        host('mw0003', fresh(0.12)),
        host('demo-claude', fresh(0.12)),
        host('mw0004', fresh(0.59))
      ],
      NOW
    )
    expect(chosen?.name).toBe('demo-claude')
  })

  it('never verifies a busy, stale, unknown, unreachable or non-heavy host', () => {
    expect(
      chooseWorkflowFleetHost(
        [
          host('busy', fresh(0.6)),
          host('halve', fresh(0.71)),
          host('old', fresh(0.1, NOW - WORKFLOW_FLEET_READING_FRESH_MS - 1)),
          host('quiet', { state: 'unknown' }),
          host('down', { state: 'unreachable' }),
          host('full', { state: 'saturated' }),
          host('paused', { state: 'stale' }),
          host('primary', fresh(0.05), { heavyOk: false })
        ],
        NOW
      )
    ).toBeUndefined()
    expect(chooseWorkflowFleetHost([], NOW)).toBeUndefined()
  })

  it('accepts a reading exactly at the fresh bound', () => {
    expect(
      chooseWorkflowFleetHost(
        [host('edge', fresh(0.2, NOW - WORKFLOW_FLEET_READING_FRESH_MS))],
        NOW
      )?.name
    ).toBe('edge')
  })
})

describe('the refusal when nothing verifies', () => {
  it('names every host it looked at and how to run here instead', () => {
    expect(
      workflowFleetPlacementRefusal(
        [
          host('mw0002', { state: 'unreachable' }),
          host('mw0003', fresh(0.3, NOW - WORKFLOW_FLEET_READING_FRESH_MS - 1)),
          host('mw0004', fresh(0.85)),
          host('demo-claude', { state: 'unknown' })
        ],
        NOW
      )
    ).toBe(
      "No fleet host has verified spare capacity (mw0002: unreachable, mw0003: stale, mw0004: 0.85 load per core, demo-claude: unknown). Choose 'this computer' to run here."
    )
  })

  it('says when no host was registered at all', () => {
    expect(workflowFleetPlacementRefusal([], NOW, 'no hosts file at /x/hosts.json')).toBe(
      "No fleet host has verified spare capacity (no hosts file at /x/hosts.json). Choose 'this computer' to run here."
    )
    expect(workflowPlacementCapacityText(host('p', fresh(0.1), { heavyOk: false }), NOW)).toBe(
      'not a heavy-work host'
    )
  })

  it('names the host Build + Review cannot dispatch its workers to', () => {
    expect(buildReviewDispatchedSeatsRefusal('mw0002')).toBe(
      "Build + Review workers edit this workspace's files, so they cannot run as dispatched seats on mw0002 in this build. Choose 'this computer' to run here."
    )
  })

  it('names a busy named host with its reading and the bound', () => {
    expect(workflowNamedHostHotRefusal('mw0002', 0.93)).toBe(
      'mw0002 is too busy for this run (0.93 load per core, over 0.8). Choose another host, or force it with a reason.'
    )
  })

  it('summarizes a placement with its host, mode, choice and reading', () => {
    const host = { name: 'mw0004', machine: 'mw0004', cores: 10, loadPerCore: 0.1, readAt: NOW }
    expect(
      workflowPlacementSummary({ runsOn: 'fleet', mode: 'dispatched-seats', choice: 'named', host })
    ).toBe(`mw0004 (dispatched-seats, named, 0.10 load per core at ${new Date(NOW).toISOString()})`)
    expect(workflowPlacementSummary({ runsOn: 'local', mode: 'local' })).toBe(
      'this computer (chosen explicitly)'
    )
  })
})
