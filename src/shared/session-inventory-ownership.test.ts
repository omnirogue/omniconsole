import { describe, expect, it } from 'vitest'
import {
  classifySessionInventoryTab,
  classifySessionInventoryWorkspaceHosts,
  classifySessionInventoryWorkspaceRecords,
  exclusiveRuntimeOwnerOfWorkspaceRecords,
  type SessionInventoryWorkspaceProvenance
} from './session-inventory-ownership'
import {
  parseWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from './terminal-surface-id'

const OWNED: SessionInventoryWorkspaceProvenance = { kind: 'owned' }
const UNRESOLVED: SessionInventoryWorkspaceProvenance = { kind: 'unresolved' }

describe('session inventory ownership', () => {
  it.each([
    ['no host metadata (legacy local)', [undefined]],
    ['explicit local', ['local']],
    ['direct SSH', ['ssh:studio']],
    ['local and direct SSH records', ['local', 'ssh:studio']]
  ])('treats %s as owned', (_label, hosts) => {
    expect(classifySessionInventoryWorkspaceHosts(hosts)).toEqual({ kind: 'owned' })
  })

  it('treats one paired runtime as the owner and conflicting records as unresolved', () => {
    expect(classifySessionInventoryWorkspaceHosts(['runtime:studio'])).toEqual({
      kind: 'peer',
      environmentId: 'studio'
    })
    expect(classifySessionInventoryWorkspaceHosts(['runtime:studio', 'local'])).toEqual({
      kind: 'unresolved'
    })
    expect(classifySessionInventoryWorkspaceHosts(['runtime:studio', 'runtime:laptop'])).toEqual({
      kind: 'peer',
      environmentId: 'laptop'
    })
  })

  it('reads workspace records before repo records, and credits an exclusive owner only', () => {
    const repoConflict = ['local', 'runtime:studio']
    expect(
      classifySessionInventoryWorkspaceRecords({
        workspaceHostIds: [null, 'local'],
        repoHostIds: repoConflict
      })
    ).toEqual({ kind: 'owned' })
    expect(
      classifySessionInventoryWorkspaceRecords({ workspaceHostIds: [], repoHostIds: repoConflict })
    ).toEqual({ kind: 'unresolved' })
    expect(
      exclusiveRuntimeOwnerOfWorkspaceRecords({
        workspaceHostIds: [],
        repoHostIds: ['runtime:studio']
      })
    ).toBe('studio')
    expect(
      exclusiveRuntimeOwnerOfWorkspaceRecords({
        workspaceHostIds: [],
        repoHostIds: ['runtime:studio', 'runtime:laptop']
      })
    ).toBeNull()
    expect(
      exclusiveRuntimeOwnerOfWorkspaceRecords({ workspaceHostIds: [], repoHostIds: repoConflict })
    ).toBeNull()
  })

  it.each([
    ['a legacy tab with no metadata', {}],
    ['a local PTY', { tabId: 'tab-1', ptyId: 'daemon-1' }],
    ['a direct-SSH PTY and host', { tabId: 'tab-1', executionHostId: 'ssh:studio' }],
    ['a legacy web-prefixed tab backed by a local PTY', { tabId: 'web-terminal-x', ptyId: 'pty-1' }]
  ])('publishes %s from an owned workspace', (_label, input) => {
    const { ptyId, ...evidence } = input as { ptyId?: string; tabId?: string }
    expect(classifySessionInventoryTab(OWNED, { ...evidence, ptyIds: [ptyId] })).toEqual({
      kind: 'owned'
    })
  })

  it.each([
    ['a stamped unified tab', { executionHostId: 'runtime:studio' }, 'studio'],
    ['a remote-runtime PTY', { ptyIds: ['remote:studio@@handle'] }, 'studio'],
    ['a web-terminal mirror', { tabId: toWebTerminalSurfaceTabId('host-tab') }, null],
    ['a mirrored editor', { mirroredFromEnvironmentId: 'macbook' }, 'macbook'],
    [
      'an owner-qualified mirror',
      { tabId: toOwnerQualifiedWebTerminalSurfaceTabId('laptop', 'host-tab') },
      'laptop'
    ]
  ])('never publishes %s inside a local workspace', (_label, evidence, environmentId) => {
    expect(classifySessionInventoryTab(OWNED, evidence)).toEqual({ kind: 'peer', environmentId })
  })

  it('quarantines conflicting per-tab provenance and unresolved workspaces without evidence', () => {
    expect(
      classifySessionInventoryTab(OWNED, {
        executionHostId: 'runtime:studio',
        ptyIds: ['daemon-1']
      })
    ).toEqual({ kind: 'unverified', reason: 'conflicting-provenance' })
    expect(classifySessionInventoryTab(UNRESOLVED, { tabId: 'tab-1' })).toEqual({
      kind: 'unverified',
      reason: 'unresolved-workspace'
    })
    expect(
      classifySessionInventoryTab(UNRESOLVED, { tabId: 'tab-1', ptyIds: ['daemon-1'] })
    ).toEqual({ kind: 'owned' })
  })

  it('round-trips owner-qualified mirror ids to the original host id for RPCs', () => {
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId('env@b', 'host::tab')
    expect(parseWebTerminalSurfaceTabId(qualified)).toEqual({
      environmentId: 'env@b',
      hostTabId: 'host::tab'
    })
    expect(toHostSessionTabId(qualified)).toBe('host::tab')
    expect(toHostSessionTabId(toWebTerminalSurfaceTabId('host@@tab'))).toBe('host@@tab')
    expect(qualified).not.toContain(':')
  })
})
