import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { HOME_SESSION_HOST_FILTER, type SessionHostFilter } from './session-host-scope'
import { sessionRowHostId, sessionRowHostName, showsSessionRowHosts } from './session-row-host'

const STUDIO_ID = '7f3c2a9e-1b4d-4c6e-9a8f-2d5b6c7e8f90'
const STUDIO = `runtime:${STUDIO_ID}` as const
const VM = 'ssh:vm' as const
const EVERY: SessionHostFilter = { kinds: ['local', 'runtime', 'ssh'], hiddenHostIds: [] }

const row = (hostId: ExecutionHostId | null, displayHostId?: ExecutionHostId) => ({
  hostId,
  displayHostId
})

describe('sessionRowHostId', () => {
  it('names the computer an own workflow runs on, not the Home it lists under', () => {
    expect(sessionRowHostId(row(STUDIO, 'local'))).toBe(STUDIO)
  })

  it('names the host an SSH alias reached', () => {
    expect(sessionRowHostId(row('local', VM))).toBe(VM)
  })

  it('keeps an unknown host unknown', () => {
    expect(sessionRowHostId(row(null))).toBeNull()
  })
})

describe('showsSessionRowHosts', () => {
  it('never names computers under Home, even for an own workflow on another one', () => {
    const rows = [row('local'), row(STUDIO, 'local')]
    expect(showsSessionRowHosts(rows, HOME_SESSION_HOST_FILTER)).toBe(false)
  })

  it('stays off while every row in view is on one computer', () => {
    expect(showsSessionRowHosts([row(STUDIO), row(STUDIO)], EVERY)).toBe(false)
  })

  it('turns on once this computer and a paired one share the list', () => {
    expect(showsSessionRowHosts([row('local'), row(STUDIO)], EVERY)).toBe(true)
  })

  it('counts a row with no known host as its own computer', () => {
    expect(showsSessionRowHosts([row(null, undefined), row(STUDIO)], EVERY)).toBe(true)
  })

  it('ignores rows the host switch hides', () => {
    const filter: SessionHostFilter = { kinds: ['runtime', 'ssh'], hiddenHostIds: [VM] }
    expect(showsSessionRowHosts([row(STUDIO), row(VM), row('local')], filter)).toBe(false)
  })
})

describe('sessionRowHostName', () => {
  const labels = new Map([['vm', 'Build VM']])
  const environments = [{ id: STUDIO_ID, name: ' Mac Studio ' }]

  it("reads a paired computer's name, never its id", () => {
    expect(sessionRowHostName(STUDIO, labels, environments)).toBe('Mac Studio')
    const unnamed = sessionRowHostName(STUDIO, labels, [])
    expect(unnamed).toBe('Paired computer')
    expect(unnamed).not.toContain(STUDIO_ID)
  })

  it('reads an SSH host by its label, else its target id', () => {
    expect(sessionRowHostName(VM, labels, environments)).toBe('Build VM')
    expect(sessionRowHostName('ssh:other', labels, environments)).toBe('other')
  })

  it('reads this computer and an unknown one in words', () => {
    expect(sessionRowHostName('local', labels, environments)).toBe('This computer')
    expect(sessionRowHostName(null, labels, environments)).toBe('Unknown computer')
  })
})
