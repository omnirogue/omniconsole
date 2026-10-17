import { describe, expect, it } from 'vitest'
import {
  inventoryConfirmsWorkspaceAbsence,
  isUnpublishedWorkspacePlaceholder,
  readSessionTabsInventoryCoverage,
  snapshotAffirmsWorkspaceMembership
} from './session-tabs-absence-evidence'

const SSH_WORKTREE = 'repo-ssh::/remote/checkout'
const LOCAL_WORKTREE = 'repo-local::/Users/me/checkout'
const SSH_FOLDER = 'folder:ssh-folder'

describe('inventory absence evidence (step 6, C4)', () => {
  it('reads legacy omitted evidence as unknown, never as confirmed absence', () => {
    expect(inventoryConfirmsWorkspaceAbsence({}, LOCAL_WORKTREE)).toBe(false)
    expect(inventoryConfirmsWorkspaceAbsence({ authoritative: false }, LOCAL_WORKTREE)).toBe(false)
  })

  it('confirms every omission of a whole-inventory authoritative answer', () => {
    expect(inventoryConfirmsWorkspaceAbsence({ authoritative: true }, SSH_WORKTREE)).toBe(true)
  })

  it('confirms only omissions outside the unverified census scope', () => {
    const coverage = { unverifiedRepoIds: ['repo-ssh'], unverifiedWorkspaces: [SSH_FOLDER] }
    expect(inventoryConfirmsWorkspaceAbsence({ coverage }, LOCAL_WORKTREE)).toBe(true)
    expect(inventoryConfirmsWorkspaceAbsence({ coverage }, SSH_WORKTREE)).toBe(false)
    // Why: a repo id covers worktrees the owner never saw, not just the ones it listed.
    expect(inventoryConfirmsWorkspaceAbsence({ coverage }, 'repo-ssh::/remote/other')).toBe(false)
    expect(inventoryConfirmsWorkspaceAbsence({ coverage }, SSH_FOLDER)).toBe(false)
    expect(inventoryConfirmsWorkspaceAbsence({ coverage }, 'folder:local-folder')).toBe(true)
  })

  it('treats malformed coverage as unknown', () => {
    expect(readSessionTabsInventoryCoverage({ unverifiedRepoIds: 'repo-ssh' })).toBeUndefined()
    expect(
      inventoryConfirmsWorkspaceAbsence(
        { coverage: { unverifiedRepoIds: [1], unverifiedWorkspaces: [] } as never },
        LOCAL_WORKTREE
      )
    ).toBe(false)
  })
})

describe('per-workspace membership evidence', () => {
  const frame = { publicationEpoch: 'renderer:1', snapshotVersion: 3 }

  it('accepts an ordinary publication, including an older owner without the marker', () => {
    expect(snapshotAffirmsWorkspaceMembership(frame)).toBe(true)
    expect(
      snapshotAffirmsWorkspaceMembership({ publicationEpoch: 'renderer:1:client-navigation' })
    ).toBe(true)
  })

  it('rejects an owner-marked partial census', () => {
    expect(snapshotAffirmsWorkspaceMembership({ ...frame, membershipUnverified: true })).toBe(false)
  })

  // Pinned to the literals: older hosts emit these strings, not the constants. Every paired client
  // has a device id, so the placeholder reaches it through the per-device navigation projection,
  // which appends `:client-navigation` and adds that device's selection revision to the version.
  it.each([
    ['bare, version 0', 'none'],
    ['projected for a device', 'none:client-navigation']
  ])('recognises the unpublished placeholder %s whatever its version', (_label, epoch) => {
    for (const snapshotVersion of [0, 1, 7]) {
      expect(isUnpublishedWorkspacePlaceholder({ publicationEpoch: epoch })).toBe(true)
      const projected = { publicationEpoch: epoch, snapshotVersion }
      expect(snapshotAffirmsWorkspaceMembership(projected)).toBe(false)
    }
  })

  it('never mistakes a real epoch that merely contains the word for the placeholder', () => {
    expect(isUnpublishedWorkspacePlaceholder({ publicationEpoch: 'renderer:none' })).toBe(false)
    expect(isUnpublishedWorkspacePlaceholder({ publicationEpoch: 'none:headless-merge:abc' })).toBe(
      false
    )
  })
})
