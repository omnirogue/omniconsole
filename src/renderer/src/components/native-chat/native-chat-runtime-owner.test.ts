import { selectSshOmpChatOwner } from './native-chat-ssh-owner'
import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  selectNativeChatRuntimeEnvironmentId,
  type NativeChatRuntimeOwnerState
} from './native-chat-runtime-owner'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

/** A worktree record with a host id but deliberately no `path` — the owner
 *  selector must not depend on path resolution (KTD-1). */
function worktreeRecord(hostId: string): OwnerFixtureState['worktreesByRepo'] {
  return { repo: [{ id: 'wt-1', repoId: 'repo', hostId } as never] }
}

type OwnerFixtureState = NativeChatRuntimeOwnerState & Parameters<typeof selectSshOmpChatOwner>[0]

function state(overrides: Partial<OwnerFixtureState> = {}): OwnerFixtureState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab()] },
    worktreesByRepo: worktreeRecord('local'),
    ...overrides
  } as OwnerFixtureState
}

describe('selectNativeChatRuntimeEnvironmentId', () => {
  it('returns null for a local-owned worktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state(), 'tab-1')).toBeNull()
  })

  it('returns the decoded environment id for a runtime-owned worktree', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBe('env-1')
  })

  it('returns null for an ssh-connection worktree (Model A stays local)', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('ssh:conn-1') }),
        'tab-1'
      )
    ).toBeNull()
  })

  it('returns null when the terminal tab matches no tab in tabsByWorktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state({ tabsByWorktree: {} }), 'tab-1')).toBeNull()
  })

  it('returns the owner id even when the worktree record has no resolvable path', () => {
    // Guards KTD-1: no `path` on the worktree record and no getKnownWorktreeById —
    // the selector must still resolve the runtime owner from the host mapping alone.
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBe('env-1')
  })
})

describe('OMP ordinary SSH transcript owner', () => {
  it('pins the host from the workspace and never treats an unresolved owner as local', () => {
    const remote = state({ repos: [{ id: 'repo', connectionId: 'host-a' } as never] })
    expect(selectSshOmpChatOwner(remote, 'omp', 'tab-1')).toBe('host-a')
    expect(selectSshOmpChatOwner(state(), 'omp', 'tab-1')).toBe('unresolved-ssh-transcript-owner')
    expect(selectSshOmpChatOwner(remote, 'omp', 'missing-tab')).toBe(
      'unresolved-ssh-transcript-owner'
    )
    expect(selectSshOmpChatOwner(remote, 'omp', 'tab-1', 'paired')).toBeNull()
    expect(selectSshOmpChatOwner(remote, 'pi', 'tab-1')).toBeNull()
    expect(
      selectSshOmpChatOwner(
        state({ repos: [{ id: 'repo', connectionId: null } as never] }),
        'omp',
        'tab-1'
      )
    ).toBeNull()
  })
  it('reads a pinned SSH folder without requiring any git worktree or repository', () => {
    const folder = state({
      tabsByWorktree: { 'folder:f1': [terminalTab({ worktreeId: 'folder:f1' })] },
      worktreesByRepo: {},
      folderWorkspaces: [{ id: 'f1', executionHostId: 'ssh:folder-host' } as never]
    })
    expect(selectSshOmpChatOwner(folder, 'omp', 'tab-1')).toBe('folder-host')
  })
})
