import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

const worktree = 'repo::/worktree'

function legacyRecoveryState() {
  return {
    tabsByWorktree: {
      [worktree]: [{ id: 'web-terminal-host-tab', worktreeId: worktree } as never]
    },
    terminalLayoutsByTabId: {
      'web-terminal-host-tab': {
        root: { type: 'leaf' as const, leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: {
          'leaf-1': toRemoteRuntimePtyId('term_live', 'windows-2')
        }
      }
    },
    activeTabIdByWorktree: {},
    activeGroupIdByWorktree: {}
  }
}

const missingSnapshot = {
  worktree,
  publicationEpoch: 'mixed-version',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: []
}

describe('mixed-version web terminal orphan recovery', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('keeps the live candidate visible when incarnation evidence is unavailable', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [{ handle: 'term_live', ptyId: 'pty-live', worktreeId: worktree }],
        totalCount: 1,
        truncated: false
      }
    }))

    // Why: the frame still applies, but its omission of the live row proves nothing (step 6).
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        legacyRecoveryState(),
        missingSnapshot,
        'windows-2',
        call as never
      )
    ).resolves.toEqual({ ...missingSnapshot, membershipUnverified: true })
    expect(call).toHaveBeenCalledOnce()
  })

  it('keeps the live candidate visible when a legacy unfiltered listing truncates before it', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [{ handle: 'term_other', ptyId: 'pty-other', worktreeId: worktree }],
        totalCount: 101,
        truncated: true
      }
    }))

    // Why not dropped: applied as not affirming membership, the omitted live row is kept (and
    // labelled) while the rest of the frame lands.
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        legacyRecoveryState(),
        missingSnapshot,
        'windows-2',
        call as never
      )
    ).resolves.toEqual({ ...missingSnapshot, membershipUnverified: true })
    expect(call).toHaveBeenCalledOnce()
  })
})
