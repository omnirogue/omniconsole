import { describe, expect, it } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { structuredSessionFolderKey } from '@/lib/session-folder-identity'
import type { Tab } from '../../../../shared/tab-types'
import { resolveStructuredSessionPaneTarget } from './structured-session-pane-target'

const tab: Tab = {
  id: 'tab',
  entityId: 'chat',
  worktreeId: 'folder:workspace',
  executionHostId: 'runtime:owner',
  contentType: 'agent-session',
  label: 'chat',
  groupId: 'group',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: structuredSessionFolderKey('runtime:owner', 'chat'),
  worktreeId: tab.worktreeId,
  hostId: 'runtime:owner',
  tabId: tab.id,
  paneKey: null,
  kind: 'structured',
  structuredSessionId: 'chat',
  agent: 'codex',
  label: 'chat',
  workspaceLabel: 'folder',
  unavailable: false,
  folderKeyMigration: null
}

describe('host-qualified chat pane identity', () => {
  it('binds a paired folder session to its owner', () => {
    expect(resolveStructuredSessionPaneTarget(session, tab, tab.executionHostId!)).toEqual({
      kind: 'chat',
      target: { kind: 'environment', environmentId: 'owner' },
      sessionId: 'chat',
      tabId: 'tab'
    })
  })
  it('shows an error for missing session identity', () => {
    expect(
      resolveStructuredSessionPaneTarget(
        { ...session, structuredSessionId: undefined },
        tab,
        'runtime:owner'
      )
    ).toEqual({ kind: 'missing-session' })
  })
  it.each([
    { ...tab, executionHostId: 'local' as const },
    { ...tab, worktreeId: 'other-folder' },
    { ...tab, entityId: 'another-chat' }
  ])('rejects another host, workspace or session with the same tab id', (candidate) => {
    expect(
      resolveStructuredSessionPaneTarget(session, candidate, candidate.executionHostId!)
    ).toEqual({ kind: 'identity-mismatch' })
  })
  it('rejects a mismatched session key and pane key', () => {
    expect(
      resolveStructuredSessionPaneTarget({ ...session, sessionKey: 'other' }, tab, 'runtime:owner')
    ).toEqual({ kind: 'identity-mismatch' })
    expect(
      resolveStructuredSessionPaneTarget({ ...session, paneKey: 'other' }, tab, 'runtime:owner')
    ).toEqual({ kind: 'identity-mismatch' })
  })
  it('explains a remote-only row instead of making a local copy', () => {
    expect(resolveStructuredSessionPaneTarget(session, undefined, null)).toEqual({
      kind: 'open-on-owner'
    })
    expect(
      resolveStructuredSessionPaneTarget({ ...session, hostId: 'ssh:owner' }, tab, 'ssh:owner')
    ).toEqual({ kind: 'open-on-owner' })
  })
  it('never treats an unknown host as local', () => {
    expect(resolveStructuredSessionPaneTarget({ ...session, hostId: null }, tab, null)).toEqual({
      kind: 'owner-unverifiable'
    })
  })
})
